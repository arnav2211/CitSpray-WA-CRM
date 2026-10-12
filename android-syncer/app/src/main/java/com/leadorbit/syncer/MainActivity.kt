package com.leadorbit.syncer

import android.Manifest
import android.content.Context
import android.content.Intent
import android.content.SharedPreferences
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Environment
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.util.Log
import android.view.View
import android.webkit.CookieManager
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.LinearLayout
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import androidx.work.Constraints
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.NetworkType
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import okhttp3.OkHttpClient
import okhttp3.Request
import org.json.JSONObject
import java.util.concurrent.TimeUnit

/**
 * LeadOrbit = the CRM in a WebView + background call sync. Calls are made and
 * received in the phone's normal phone app (the old built-in LeadOrbit dialer is
 * gone); every call is read from the phone's call log, and the phone's own call
 * recording is uploaded for an AI summary (RecordingSyncWorker).
 */
class MainActivity : AppCompatActivity() {

    private lateinit var webView: WebView
    private lateinit var permissionOverlay: LinearLayout
    private lateinit var grantButton: Button
    private lateinit var sharedPrefs: SharedPreferences

    private val handler = Handler(Looper.getMainLooper())
    private val tokenCheckRunnable = object : Runnable {
        override fun run() {
            extractTokenFromWebView()
            handler.postDelayed(this, 10000) // check every 10 seconds
        }
    }

    private val requestPermissionLauncher = registerForActivityResult(
        ActivityResultContracts.RequestMultiplePermissions()
    ) { _ ->
        if (hasRequiredPermissions()) setupAppFlow() else showPermissionRequestUI()
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)

        webView = findViewById(R.id.webView)
        permissionOverlay = findViewById(R.id.permissionOverlay)
        grantButton = findViewById(R.id.grantButton)
        sharedPrefs = getSharedPreferences("CRM_PREFS", Context.MODE_PRIVATE)
        findViewById<View>(R.id.activeCallBanner)?.visibility = View.GONE

        grantButton.setOnClickListener { checkAndRequestPermissions() }

        if (hasRequiredPermissions()) setupAppFlow() else showPermissionRequestUI()
    }

    private fun requiredPermissions(): List<String> {
        val list = mutableListOf(
            Manifest.permission.READ_PHONE_STATE,
            Manifest.permission.READ_CALL_LOG,
            Manifest.permission.READ_CONTACTS
        )
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            list.add(Manifest.permission.POST_NOTIFICATIONS)
            list.add(Manifest.permission.READ_MEDIA_AUDIO)          // call recordings
        } else {
            list.add(Manifest.permission.READ_EXTERNAL_STORAGE)
        }
        if (Build.VERSION.SDK_INT <= Build.VERSION_CODES.Q) {
            // Android 10 and older: lets the app delete uploaded call recordings
            list.add(Manifest.permission.WRITE_EXTERNAL_STORAGE)
        }
        return list
    }

    private fun hasRequiredPermissions(): Boolean =
        requiredPermissions().all { ContextCompat.checkSelfPermission(this, it) == PackageManager.PERMISSION_GRANTED }

    private fun checkAndRequestPermissions() {
        requestPermissionLauncher.launch(requiredPermissions().toTypedArray())
    }

    private fun showPermissionRequestUI() {
        webView.visibility = View.GONE
        permissionOverlay.visibility = View.VISIBLE
    }

    private fun setupAppFlow() {
        permissionOverlay.visibility = View.GONE
        webView.visibility = View.VISIBLE

        setupWebView()
        setupBackgroundSyncWorker()

        if (sharedPrefs.getString("auth_token", null) != null) {
            startNotificationService()
            syncPhoneLeadMap()
        }

        // Self-update: if a newer APK is published on the server, offer a
        // one-tap "Install now" dialog
        handler.postDelayed({ UpdateManager.checkForUpdate(this) }, 3000)
        // Deleting the phone's call recordings after upload needs "All files access"
        handler.postDelayed({ askAllFilesAccessOnce() }, 6000)

        // Process any pending deep-link navigation path
        handleNavPath(intent)
    }

    /** Ask (at most once a day) for "All files access" so uploaded recordings can be deleted from the phone. */
    private fun askAllFilesAccessOnce() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R || Environment.isExternalStorageManager()) return
        val last = sharedPrefs.getLong("all_files_asked_at", 0L)
        if (System.currentTimeMillis() - last < 24 * 3600 * 1000L) return
        sharedPrefs.edit().putLong("all_files_asked_at", System.currentTimeMillis()).apply()
        if (isFinishing) return
        AlertDialog.Builder(this)
            .setTitle("Allow file access")
            .setMessage("LeadOrbit uploads each call recording for an AI summary and then deletes it from this phone. " +
                    "To delete it, turn ON \"Allow access to manage all files\" for LeadOrbit on the next screen.")
            .setPositiveButton("Open settings") { _, _ ->
                try {
                    startActivity(Intent(Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION, Uri.parse("package:$packageName")))
                } catch (e: Exception) {
                    startActivity(Intent(Settings.ACTION_MANAGE_ALL_FILES_ACCESS_PERMISSION))
                }
            }
            .setNegativeButton("Later", null)
            .show()
    }

    private fun setupWebView() {
        val settings = webView.settings
        settings.javaScriptEnabled = true
        settings.domStorageEnabled = true
        settings.databaseEnabled = true
        settings.loadWithOverviewMode = true
        settings.useWideViewPort = true
        settings.cacheMode = WebSettings.LOAD_DEFAULT

        val cookieManager = CookieManager.getInstance()
        cookieManager.setAcceptCookie(true)
        cookieManager.setAcceptThirdPartyCookies(webView, true)

        webView.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView?, request: WebResourceRequest?): Boolean {
                val url = request?.url?.toString() ?: ""
                if (url.startsWith("tel:") || url.contains("dialer")) {
                    openPhoneApp(if (url.startsWith("tel:")) url.substring(4) else "")
                    return true
                }
                return super.shouldOverrideUrlLoading(view, request)
            }

            @Deprecated("Deprecated in Java")
            override fun shouldOverrideUrlLoading(view: WebView?, url: String?): Boolean {
                if (url != null && (url.startsWith("tel:") || url.contains("dialer"))) {
                    openPhoneApp(if (url.startsWith("tel:")) url.substring(4) else "")
                    return true
                }
                @Suppress("DEPRECATION")
                return super.shouldOverrideUrlLoading(view, url)
            }

            override fun onPageFinished(view: WebView?, url: String?) {
                super.onPageFinished(view, url)
                handler.removeCallbacks(tokenCheckRunnable)
                handler.post(tokenCheckRunnable)
            }
        }

        // One-time cache purge so this update immediately picks up the freshly
        // deployed frontend instead of a stale cached bundle
        if (!sharedPrefs.getBoolean("webview_cache_cleared_v2", false)) {
            webView.clearCache(true)
            sharedPrefs.edit().putBoolean("webview_cache_cleared_v2", true).apply()
        }

        webView.loadUrl("https://crm.mangalamagro.in/chat")
    }

    /** Calls happen in the phone's normal phone app; the call log sync picks them up. */
    private fun openPhoneApp(rawNumber: String) {
        val number = Uri.decode(rawNumber).replace(Regex("[^0-9+]"), "")
        val intent = if (number.isEmpty()) Intent(Intent.ACTION_DIAL) else Intent(Intent.ACTION_DIAL, Uri.parse("tel:$number"))
        try {
            startActivity(intent)
        } catch (e: Exception) {
            Log.e("MainActivity", "No phone app to open: ${e.message}")
        }
    }

    private fun extractTokenFromWebView() {
        webView.evaluateJavascript("localStorage.getItem('token')") { tokenJson ->
            if (tokenJson != null && tokenJson != "null" && tokenJson.isNotEmpty()) {
                val cleanToken = tokenJson.trim('"')
                if (cleanToken.isNotEmpty()) {
                    val currentToken = sharedPrefs.getString("auth_token", null)
                    if (cleanToken != currentToken) {
                        sharedPrefs.edit().putString("auth_token", cleanToken).apply()
                        startNotificationService()
                        syncPhoneLeadMap()
                    }
                }
            }
        }

        webView.evaluateJavascript("localStorage.getItem('user')") { userJson ->
            if (userJson != null && userJson != "null" && userJson.isNotEmpty()) {
                try {
                    val unescaped = userJson.replace("\\\"", "\"").trim('"')
                    val userObj = JSONObject(unescaped)
                    val userId = userObj.optString("id")
                    val userName = userObj.optString("name")
                    if (userId.isNotEmpty()) {
                        sharedPrefs.edit()
                            .putString("user_id", userId)
                            .putString("user_name", userName)
                            .apply()
                    }
                } catch (e: Exception) {
                    // Ignore parsing errors
                }
            }
        }
    }

    private fun setupBackgroundSyncWorker() {
        val constraints = Constraints.Builder()
            .setRequiredNetworkType(NetworkType.CONNECTED)
            .build()
        val wm = WorkManager.getInstance(applicationContext)
        wm.enqueueUniquePeriodicWork(
            "CallSyncWorker", ExistingPeriodicWorkPolicy.KEEP,
            PeriodicWorkRequestBuilder<SyncWorker>(15, TimeUnit.MINUTES).setConstraints(constraints).build()
        )
        // Safety net for recordings that appear late / uploads that failed offline
        wm.enqueueUniquePeriodicWork(
            "RecordingSyncWorker", ExistingPeriodicWorkPolicy.KEEP,
            PeriodicWorkRequestBuilder<RecordingSyncWorker>(15, TimeUnit.MINUTES).setConstraints(constraints).build()
        )
        RecordingSyncWorker.enqueueSoon(applicationContext, 5)
    }

    @Deprecated("Deprecated in Java")
    override fun onBackPressed() {
        if (webView.canGoBack()) {
            webView.goBack()
        } else {
            @Suppress("DEPRECATION")
            super.onBackPressed()
        }
    }

    private fun startNotificationService() {
        val serviceIntent = Intent(this, NotificationSyncService::class.java).apply {
            action = NotificationSyncService.ACTION_START
        }
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                startForegroundService(serviceIntent)
            } else {
                startService(serviceIntent)
            }
        } catch (e: Exception) {
            Log.e("MainActivity", "Failed to start NotificationSyncService", e)
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        handleNavPath(intent)
    }

    private fun handleNavPath(intent: Intent) {
        val path = intent.getStringExtra("nav_path")
        if (!path.isNullOrEmpty()) {
            webView.loadUrl("https://crm.mangalamagro.in" + path)
        }
    }

    private fun syncPhoneLeadMap() {
        val token = sharedPrefs.getString("auth_token", null) ?: return
        Thread {
            try {
                val client = OkHttpClient()
                val request = Request.Builder()
                    .url("https://crm.mangalamagro.in/api/leads/phone-map")
                    .addHeader("Authorization", "Bearer $token")
                    .build()
                client.newCall(request).execute().use { response ->
                    if (response.isSuccessful) {
                        val bodyString = response.body?.string()
                        if (!bodyString.isNullOrEmpty()) {
                            sharedPrefs.edit().putString("phone_lead_map_json", bodyString).apply()
                        }
                    }
                }
            } catch (e: Exception) {
                Log.e("MainActivity", "Failed to sync phone-lead map: ${e.message}")
            }
        }.start()
    }

    override fun onResume() {
        super.onResume()
        handler.removeCallbacks(tokenCheckRunnable)
        handler.post(tokenCheckRunnable)
    }

    override fun onPause() {
        super.onPause()
        handler.removeCallbacks(tokenCheckRunnable)
    }

    override fun onDestroy() {
        super.onDestroy()
        handler.removeCallbacks(tokenCheckRunnable)
    }
}
