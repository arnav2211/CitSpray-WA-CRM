package com.leadorbit.syncer

import android.Manifest
import android.content.Context
import android.content.SharedPreferences
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.View
import android.webkit.CookieManager
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.ImageButton
import android.widget.LinearLayout
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import androidx.work.Constraints
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.NetworkType
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import org.json.JSONObject
import java.util.concurrent.TimeUnit
import android.net.Uri
import android.content.Intent
import android.util.Log
import android.telephony.PhoneNumberUtils
import android.telecom.TelecomManager
import android.app.role.RoleManager
import android.webkit.WebResourceRequest
import okhttp3.OkHttpClient
import okhttp3.Request
import android.telecom.Call
import android.widget.TextView
import android.widget.Chronometer
import android.widget.ImageView

class MainActivity : AppCompatActivity() {

    private lateinit var webView: WebView
    private lateinit var permissionOverlay: LinearLayout
    private lateinit var grantButton: Button
    private lateinit var sharedPrefs: SharedPreferences
    
    private lateinit var activeCallBanner: View
    private lateinit var bannerCallerName: TextView
    private lateinit var bannerCallTimer: Chronometer
    private lateinit var bannerHangupButton: ImageButton
    private var bannerCall: Call? = null
    
    private val handler = Handler(Looper.getMainLooper())
    private val tokenCheckRunnable = object : Runnable {
        override fun run() {
            extractTokenFromWebView()
            handler.postDelayed(this, 10000) // check every 10 seconds
        }
    }

    private val requestPermissionLauncher = registerForActivityResult(
        ActivityResultContracts.RequestMultiplePermissions()
    ) { permissions ->
        val allGranted = permissions.entries.all { it.value }
        if (allGranted) {
            setupAppFlow()
        } else {
            showPermissionRequestUI()
        }
    }

    private val requestDialerLauncher = registerForActivityResult(
        ActivityResultContracts.StartActivityForResult()
    ) { _ ->
        // Checked when returning from default phone app selection
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)

        webView = findViewById(R.id.webView)
        permissionOverlay = findViewById(R.id.permissionOverlay)
        grantButton = findViewById(R.id.grantButton)
        sharedPrefs = getSharedPreferences("CRM_PREFS", Context.MODE_PRIVATE)

        grantButton.setOnClickListener {
            checkAndRequestPermissions()
        }


        activeCallBanner = findViewById(R.id.activeCallBanner)
        bannerCallerName = findViewById(R.id.bannerCallerName)
        bannerCallTimer = findViewById(R.id.bannerCallTimer)
        bannerHangupButton = findViewById(R.id.bannerHangupButton)

        if (hasRequiredPermissions()) {
            setupAppFlow()
        } else {
            showPermissionRequestUI()
        }
    }

    private fun hasRequiredPermissions(): Boolean {
        val phoneState = ContextCompat.checkSelfPermission(this, Manifest.permission.READ_PHONE_STATE)
        val callLog = ContextCompat.checkSelfPermission(this, Manifest.permission.READ_CALL_LOG)
        val callPhone = ContextCompat.checkSelfPermission(this, Manifest.permission.CALL_PHONE)
        val recordAudio = ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO)
        val readContacts = ContextCompat.checkSelfPermission(this, Manifest.permission.READ_CONTACTS)
        
        var notificationsGranted = true
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            notificationsGranted = ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED
        }
        
        return phoneState == PackageManager.PERMISSION_GRANTED &&
                callLog == PackageManager.PERMISSION_GRANTED &&
                callPhone == PackageManager.PERMISSION_GRANTED &&
                recordAudio == PackageManager.PERMISSION_GRANTED &&
                readContacts == PackageManager.PERMISSION_GRANTED &&
                notificationsGranted
    }

    private fun checkAndRequestPermissions() {
        val permissionsList = mutableListOf(
            Manifest.permission.READ_PHONE_STATE,
            Manifest.permission.READ_CALL_LOG,
            Manifest.permission.CALL_PHONE,
            Manifest.permission.RECORD_AUDIO,
            Manifest.permission.READ_CONTACTS
        )
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            permissionsList.add(Manifest.permission.POST_NOTIFICATIONS)
        }
        requestPermissionLauncher.launch(permissionsList.toTypedArray())
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
        
        // LeadOrbit no longer takes over as the default phone app: calls run
        // through the phone's regular dialer (fast + familiar, works on old
        // devices), while CallReceiver + SyncWorker still pull every call from
        // the CallLog in near-real-time.

        // Process any pending deep-link navigation path
        handleNavPath(intent)
    }

    private fun setupWebView() {
        val settings = webView.settings
        settings.javaScriptEnabled = true
        settings.domStorageEnabled = true
        settings.databaseEnabled = true
        settings.loadWithOverviewMode = true
        settings.useWideViewPort = true
        settings.cacheMode = WebSettings.LOAD_DEFAULT
        
        // Handle cookies
        val cookieManager = CookieManager.getInstance()
        cookieManager.setAcceptCookie(true)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
            cookieManager.setAcceptThirdPartyCookies(webView, true)
        }

        webView.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView?, request: WebResourceRequest?): Boolean {
                val url = request?.url?.toString() ?: ""
                if (url.startsWith("tel:") || url.contains("dialer")) {
                    val rawNum = if (url.startsWith("tel:")) url.substring(4) else "dialer"
                    placeCall(rawNum)
                    return true
                }
                return super.shouldOverrideUrlLoading(view, request)
            }

            @Deprecated("Deprecated in Java")
            override fun shouldOverrideUrlLoading(view: WebView?, url: String?): Boolean {
                if (url != null) {
                    if (url.startsWith("tel:") || url.contains("dialer")) {
                        val rawNum = if (url.startsWith("tel:")) url.substring(4) else "dialer"
                        placeCall(rawNum)
                        return true
                    }
                }
                @Suppress("DEPRECATION")
                return super.shouldOverrideUrlLoading(view, url)
            }

            override fun onPageFinished(view: WebView?, url: String?) {
                super.onPageFinished(view, url)
                // Start extraction loops once the page loads
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

        // Default CRM URL on the VPS
        webView.loadUrl("https://crm.mangalamagro.in/chat")
    }

    private fun checkAndRequestDefaultDialer() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            val roleManager = getSystemService(RoleManager::class.java)
            if (roleManager != null && !roleManager.isRoleHeld(RoleManager.ROLE_DIALER)) {
                val intent = roleManager.createRequestRoleIntent(RoleManager.ROLE_DIALER)
                requestDialerLauncher.launch(intent)
            }
        } else {
            val telecomManager = getSystemService(TelecomManager::class.java)
            if (telecomManager != null && telecomManager.defaultDialerPackage != packageName) {
                val intent = Intent(TelecomManager.ACTION_CHANGE_DEFAULT_DIALER).apply {
                    putExtra(TelecomManager.EXTRA_CHANGE_DEFAULT_DIALER_PACKAGE_NAME, packageName)
                }
                requestDialerLauncher.launch(intent)
            }
        }
    }

    private fun placeCall(phoneNumber: String) {
        val cleanNumber = phoneNumber.replace("/", "").trim().lowercase()
        if (cleanNumber == "dialer" || cleanNumber.isEmpty()) {
            startActivity(Intent(this, DialpadActivity::class.java))
        } else {
            CallHelper.placeCall(this, phoneNumber)
        }
    }

    private fun extractTokenFromWebView() {
        // Evaluate JavaScript to fetch local storage values
        webView.evaluateJavascript("localStorage.getItem('token')") { tokenJson ->
            if (tokenJson != null && tokenJson != "null" && tokenJson.isNotEmpty()) {
                // Remove outer quotes from evaluated js string
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
                    // evaluated JSON string may have escaped quotes, need to clean it up
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

        val syncRequest = PeriodicWorkRequestBuilder<SyncWorker>(15, TimeUnit.MINUTES)
            .setConstraints(constraints)
            .build()

        WorkManager.getInstance(applicationContext).enqueueUniquePeriodicWork(
            "CallSyncWorker",
            ExistingPeriodicWorkPolicy.KEEP,
            syncRequest
        )
    }

    override fun onBackPressed() {
        if (webView.canGoBack()) {
            webView.goBack()
        } else {
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
            Log.i("MainActivity", "NotificationSyncService started successfully")
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
                            Log.d("MainActivity", "Successfully synced phone-lead map.")
                        }
                    }
                }
            } catch (e: Exception) {
                Log.e("MainActivity", "Failed to sync phone-lead map: ${e.message}")
            }
        }.start()
    }

    private val callListener = object : CallService.CallListener {
        override fun onCallStarted(call: Call) {
            runOnUiThread {
                showActiveCallBanner(call)
            }
        }
        override fun onCallEnded() {
            runOnUiThread {
                hideActiveCallBanner()
            }
        }
    }

    private val bannerCallCallback = object : Call.Callback() {
        override fun onStateChanged(call: Call, state: Int) {
            super.onStateChanged(call, state)
            runOnUiThread {
                updateBannerState(call)
            }
        }
    }

    override fun onResume() {
        super.onResume()
        CallService.listener = callListener
        val active = CallService.activeCall
        if (active != null) {
            showActiveCallBanner(active)
        } else {
            hideActiveCallBanner()
        }
        handler.removeCallbacks(tokenCheckRunnable)
        handler.post(tokenCheckRunnable)
    }

    override fun onPause() {
        super.onPause()
        if (CallService.listener == callListener) {
            CallService.listener = null
        }
        handler.removeCallbacks(tokenCheckRunnable)
    }

    private fun showActiveCallBanner(call: Call) {
        val number = call.details.handle?.schemeSpecificPart ?: "Unknown"
        LeadLookup.loadMap(this)
        val lead = LeadLookup.lookup(number)
        
        val nameText = when {
            lead != null -> {
                val statusStr = if (!lead.status.isNullOrEmpty()) " (${lead.status.uppercase()})" else ""
                "${lead.name}$statusStr"
            }
            else -> number
        }
        
        bannerCallerName.text = nameText
        activeCallBanner.visibility = View.VISIBLE
        
        updateBannerState(call)
        
        bannerCall?.unregisterCallback(bannerCallCallback)
        bannerCall = call
        call.registerCallback(bannerCallCallback)
        
        activeCallBanner.setOnClickListener {
            val intent = Intent(this, CallActivity::class.java).apply {
                flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP
            }
            startActivity(intent)
        }
        
        bannerHangupButton.setOnClickListener {
            CallService.hangUp()
        }
    }

    private fun hideActiveCallBanner() {
        activeCallBanner.visibility = View.GONE
        bannerCallTimer.stop()
        bannerCall?.unregisterCallback(bannerCallCallback)
        bannerCall = null
    }

    private fun updateBannerState(call: Call) {
        if (call.state == Call.STATE_ACTIVE) {
            val connectTime = call.details.connectTimeMillis
            val baseTime = if (connectTime > 0L) {
                android.os.SystemClock.elapsedRealtime() - (System.currentTimeMillis() - connectTime)
            } else {
                android.os.SystemClock.elapsedRealtime()
            }
            bannerCallTimer.base = baseTime
            bannerCallTimer.start()
            bannerCallTimer.visibility = View.VISIBLE
        } else {
            bannerCallTimer.stop()
            bannerCallTimer.visibility = View.GONE
        }
    }

    override fun onDestroy() {
        super.onDestroy()
        handler.removeCallbacks(tokenCheckRunnable)
        bannerCall?.unregisterCallback(bannerCallCallback)
    }
}
