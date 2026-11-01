package com.leadorbit.syncer

import android.Manifest
import android.app.DownloadManager
import android.content.ActivityNotFoundException
import android.content.ContentValues
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
import android.annotation.SuppressLint
import android.app.NotificationManager
import android.content.BroadcastReceiver
import android.content.IntentFilter
import android.media.AudioDeviceCallback
import android.media.AudioDeviceInfo
import android.media.AudioManager
import android.os.PowerManager
import android.provider.MediaStore
import android.util.Base64
import android.view.ViewGroup
import android.view.WindowManager
import android.webkit.MimeTypeMap
import android.webkit.URLUtil
import android.webkit.ValueCallback
import android.widget.FrameLayout
import android.widget.Toast
import androidx.core.content.FileProvider
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import android.webkit.CookieManager
import android.webkit.JavascriptInterface
import android.webkit.PermissionRequest
import android.webkit.WebChromeClient
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
import java.io.File
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

    // WhatsApp calls: the microphone (asked separately so the app never blocks on it)
    private var pendingMicRequest: PermissionRequest? = null
    private val micPermissionLauncher = registerForActivityResult(
        ActivityResultContracts.RequestPermission()
    ) { granted ->
        pendingMicRequest?.let { req ->
            if (granted) req.grant(arrayOf(PermissionRequest.RESOURCE_AUDIO_CAPTURE)) else req.deny()
        }
        pendingMicRequest = null
    }
    private var proximityLock: PowerManager.WakeLock? = null

    // Chat: attach photos / videos / documents (the page's <input type=file>)
    private var fileCallback: ValueCallback<Array<Uri>>? = null
    private val fileChooserLauncher = registerForActivityResult(
        ActivityResultContracts.StartActivityForResult()
    ) { res ->
        val cb = fileCallback ?: return@registerForActivityResult
        fileCallback = null
        val uris = mutableListOf<Uri>()
        val data = res.data
        if (res.resultCode == RESULT_OK && data != null) {
            val clip = data.clipData
            if (clip != null) for (i in 0 until clip.itemCount) clip.getItemAt(i).uri?.let { uris.add(it) }
            else data.data?.let { uris.add(it) }
        }
        cb.onReceiveValue(if (uris.isEmpty()) null else uris.toTypedArray())
    }

    // Chat camera / voice notes: the page asks for camera and/or microphone
    private var pendingWebRequest: PermissionRequest? = null
    private val webPermLauncher = registerForActivityResult(
        ActivityResultContracts.RequestMultiplePermissions()
    ) { _ ->
        pendingWebRequest?.let { grantWebRequest(it, ask = false) }
        pendingWebRequest = null
    }

    // Full-screen video
    private var fullView: View? = null
    private var fullCallback: WebChromeClient.CustomViewCallback? = null

    // ---- call audio routing (WhatsApp calls) ----
    private var callRoute = "speaker"
    private var autoRoute = true          // follow Bluetooth / wired connecting and disconnecting
    private var inCall = false
    private val audioDeviceCallback = object : AudioDeviceCallback() {
        override fun onAudioDevicesAdded(addedDevices: Array<out AudioDeviceInfo>) { onRoutesChanged() }
        override fun onAudioDevicesRemoved(removedDevices: Array<out AudioDeviceInfo>) { onRoutesChanged() }
    }

    private fun routeOf(type: Int): String? = when (type) {
        AudioDeviceInfo.TYPE_BLUETOOTH_SCO -> "bluetooth"
        AudioDeviceInfo.TYPE_WIRED_HEADSET, AudioDeviceInfo.TYPE_WIRED_HEADPHONES, AudioDeviceInfo.TYPE_USB_HEADSET -> "wired"
        AudioDeviceInfo.TYPE_BUILTIN_SPEAKER -> "speaker"
        AudioDeviceInfo.TYPE_BUILTIN_EARPIECE -> "earpiece"
        else -> if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S && type == AudioDeviceInfo.TYPE_BLE_HEADSET) "bluetooth" else null
    }

    /** Available call routes: route -> device (null device = legacy API routing). */
    private fun availableRoutes(am: AudioManager): LinkedHashMap<String, AudioDeviceInfo?> {
        val out = LinkedHashMap<String, AudioDeviceInfo?>()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            for (d in am.availableCommunicationDevices) {
                val r = routeOf(d.type) ?: continue
                if (!out.containsKey(r)) out[r] = d
            }
        } else {
            for (d in am.getDevices(AudioManager.GET_DEVICES_OUTPUTS)) {
                val r = routeOf(d.type) ?: continue
                if (!out.containsKey(r)) out[r] = null
            }
            out.putIfAbsent("speaker", null)
            out.putIfAbsent("earpiece", null)
        }
        return out
    }

    private fun autoChoice(routes: Map<String, AudioDeviceInfo?>): String =
        listOf("bluetooth", "wired", "speaker", "earpiece").firstOrNull { routes.containsKey(it) } ?: "speaker"

    @Suppress("DEPRECATION")
    private fun applyRoute(route: String) {
        val am = getSystemService(Context.AUDIO_SERVICE) as AudioManager
        val routes = availableRoutes(am)
        val r = if (routes.containsKey(route)) route else autoChoice(routes)
        am.mode = AudioManager.MODE_IN_COMMUNICATION
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            val dev = routes[r]
            if (dev != null) am.setCommunicationDevice(dev)
        } else {
            if (r == "bluetooth") {
                am.isSpeakerphoneOn = false
                try { am.startBluetoothSco(); am.isBluetoothScoOn = true } catch (e: Exception) { }
            } else {
                try { am.stopBluetoothSco(); am.isBluetoothScoOn = false } catch (e: Exception) { }
                am.isSpeakerphoneOn = (r == "speaker")
            }
        }
        callRoute = r
        // screen off at the ear only when the sound comes from the earpiece
        try {
            if (r == "earpiece") proximityLock?.let { if (!it.isHeld) it.acquire(3 * 3600 * 1000L) }
            else proximityLock?.let { if (it.isHeld) it.release() }
        } catch (e: Exception) { }
        webView.evaluateJavascript("window.__waAudioRoute && window.__waAudioRoute('$r', '${routes.keys.joinToString(",")}')", null)
    }

    private fun onRoutesChanged() {
        if (!inCall) return
        runOnUiThread {
            val am = getSystemService(Context.AUDIO_SERVICE) as AudioManager
            val routes = availableRoutes(am)
            // like a phone app: a headset that connects takes the call; if the chosen one disappears, fall back
            if (autoRoute || !routes.containsKey(callRoute)) applyRoute(autoChoice(routes))
            else webView.evaluateJavascript("window.__waAudioRoute && window.__waAudioRoute('$callRoute', '${routes.keys.joinToString(",")}')", null)
        }
    }

    @Suppress("DEPRECATION")
    private fun resetCallAudio() {
        val am = getSystemService(Context.AUDIO_SERVICE) as AudioManager
        try { am.unregisterAudioDeviceCallback(audioDeviceCallback) } catch (e: Exception) { }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) am.clearCommunicationDevice()
        try { am.stopBluetoothSco(); am.isBluetoothScoOn = false } catch (e: Exception) { }
        am.isSpeakerphoneOn = false
        am.mode = AudioManager.MODE_NORMAL
        inCall = false
        autoRoute = true
    }
    private var appSetUp = false
    private val hangupReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) {
            webView.evaluateJavascript("window.__waCallHangup && window.__waCallHangup()", null)
        }
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
        ContextCompat.registerReceiver(this, hangupReceiver, IntentFilter(OngoingCallService.HANGUP_BROADCAST),
            ContextCompat.RECEIVER_NOT_EXPORTED)
        prepareForCall(intent)

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
        if (appSetUp) { handleNavPath(intent); return }
        appSetUp = true
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
        // WhatsApp calls must ring even when the app is closed / phone locked
        handler.postDelayed({ askCallRingSetup() }, 9000)
    }

    /** Opened from an incoming WhatsApp call: show over the lock screen and stop the ringing here. */
    private fun prepareForCall(i: Intent?) {
        val callId = i?.getStringExtra("wa_call_id") ?: return
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
            setShowWhenLocked(true)
            setTurnScreenOn(true)
        } else {
            @Suppress("DEPRECATION")
            window.addFlags(WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED or WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON)
        }
        WaCallNotifier.clear(this, callId)
        try {
            startService(Intent(this, NotificationSyncService::class.java).apply {
                action = NotificationSyncService.ACTION_WA_STOP_RING
                putExtra("call_id", callId)
            })
        } catch (e: Exception) { }
    }

    /**
     * Once per 12 h, until done: the three phone settings that let a WhatsApp call ring
     * like a real call - full-screen call screen, show over other apps, and no battery
     * restriction (so the connection stays alive when the app is closed).
     */
    private fun askCallRingSetup() {
        if (isFinishing) return
        val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        val steps = mutableListOf<Pair<String, Intent>>()
        if (Build.VERSION.SDK_INT >= 34 && !nm.canUseFullScreenIntent()) {
            steps.add("Allow full-screen notifications" to Intent(Settings.ACTION_MANAGE_APP_USE_FULL_SCREEN_INTENT, Uri.parse("package:$packageName")))
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M && !Settings.canDrawOverlays(this)) {
            steps.add("Allow \"Display over other apps\"" to Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION, Uri.parse("package:$packageName")))
        }
        val pm = getSystemService(Context.POWER_SERVICE) as PowerManager
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M && !pm.isIgnoringBatteryOptimizations(packageName)) {
            @SuppressLint("BatteryLife")
            val i = Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:$packageName"))
            steps.add("Battery: \"Don't optimise\" / Unrestricted" to i)
        }
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            micPermissionLauncher.launch(Manifest.permission.RECORD_AUDIO)
        }
        if (steps.isEmpty()) return
        val last = sharedPrefs.getLong("call_setup_asked_at", 0L)
        if (System.currentTimeMillis() - last < 12 * 3600 * 1000L) return
        sharedPrefs.edit().putLong("call_setup_asked_at", System.currentTimeMillis()).apply()
        val first = steps.first()
        AlertDialog.Builder(this)
            .setTitle("Let WhatsApp calls ring")
            .setMessage("So customers' WhatsApp calls ring on this phone even when LeadOrbit is closed or the phone is locked, please turn on:\n\n" +
                    steps.joinToString("\n") { "• " + it.first } + "\n\nTap Open settings for: " + first.first)
            .setPositiveButton("Open settings") { _, _ ->
                try { startActivity(first.second) } catch (e: Exception) {
                    try { startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:$packageName"))) } catch (e2: Exception) { }
                }
                // next missing item is offered the next time the app is opened
                sharedPrefs.edit().putLong("call_setup_asked_at", 0L).apply()
            }
            .setNegativeButton("Later", null)
            .show()
    }

    /** Called by the WhatsApp call page inside the WebView. */
    inner class NativeBridge {
        @JavascriptInterface
        fun callState(state: String, name: String) {
            runOnUiThread {
                if (state == "active") {
                    window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) setShowWhenLocked(true)
                    OngoingCallService.start(this@MainActivity, name)
                    try {
                        val pm = getSystemService(Context.POWER_SERVICE) as PowerManager
                        if (pm.isWakeLockLevelSupported(PowerManager.PROXIMITY_SCREEN_OFF_WAKE_LOCK) && proximityLock == null) {
                            proximityLock = pm.newWakeLock(PowerManager.PROXIMITY_SCREEN_OFF_WAKE_LOCK, "LeadOrbit:waCall").apply { acquire(3 * 3600 * 1000L) }
                        }
                    } catch (e: Exception) { }
                } else {
                    window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) setShowWhenLocked(false)
                    OngoingCallService.stop(this@MainActivity)
                    try { proximityLock?.let { if (it.isHeld) it.release() } } catch (e: Exception) { }
                    proximityLock = null
                    resetCallAudio()
                }
            }
        }

        /** "auto" = Bluetooth > wired > loudspeaker, following devices as they come and go. */
        @JavascriptInterface
        fun setAudioRoute(route: String) {
            runOnUiThread {
                val am = getSystemService(Context.AUDIO_SERVICE) as AudioManager
                if (!inCall) {
                    inCall = true
                    try { am.registerAudioDeviceCallback(audioDeviceCallback, Handler(Looper.getMainLooper())) } catch (e: Exception) { }
                }
                autoRoute = route == "auto"
                applyRoute(if (autoRoute) autoChoice(availableRoutes(am)) else route)
            }
        }

        /** A file made inside the page (blob:/data: link with download=...) -> phone's Downloads. */
        @JavascriptInterface
        fun saveDataUrl(dataUrl: String, name: String, mime: String) {
            try {
                val comma = dataUrl.indexOf(',')
                val bytes = Base64.decode(dataUrl.substring(comma + 1), Base64.DEFAULT)
                val m = mime.ifEmpty { dataUrl.substringAfter("data:", "").substringBefore(';').ifEmpty { "application/octet-stream" } }
                saveBytesToDownloads(name.ifEmpty { "download" }, m, bytes)
            } catch (e: Exception) {
                runOnUiThread { toast("Couldn't save the file") }
            }
        }

        /** JSON: {"route": current, "routes": [available…]} */
        @JavascriptInterface
        fun audioRoutes(): String {
            val am = getSystemService(Context.AUDIO_SERVICE) as AudioManager
            val routes = availableRoutes(am).keys
            return "{\"route\":\"$callRoute\",\"routes\":[" + routes.joinToString(",") { "\"$it\"" } + "]}"
        }

        @JavascriptInterface
        fun setSpeaker(on: Boolean) {
            runOnUiThread {
                val am = getSystemService(Context.AUDIO_SERVICE) as AudioManager
                am.mode = AudioManager.MODE_IN_COMMUNICATION
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                    val type = if (on) android.media.AudioDeviceInfo.TYPE_BUILTIN_SPEAKER else android.media.AudioDeviceInfo.TYPE_BUILTIN_EARPIECE
                    val dev = am.availableCommunicationDevices.firstOrNull { it.type == type }
                    if (dev != null) am.setCommunicationDevice(dev) else am.isSpeakerphoneOn = on
                } else {
                    am.isSpeakerphoneOn = on
                }
                // speaker: no proximity screen-off
                try {
                    if (on) { proximityLock?.let { if (it.isHeld) it.release() } }
                    else proximityLock?.let { if (!it.isHeld) it.acquire(3 * 3600 * 1000L) }
                } catch (e: Exception) { }
            }
        }
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
        settings.mediaPlaybackRequiresUserGesture = false      // call audio plays at once
        webView.addJavascriptInterface(NativeBridge(), "LeadOrbitNative")
        webView.webChromeClient = object : WebChromeClient() {
            override fun onPermissionRequest(request: PermissionRequest) {
                runOnUiThread {
                    val host = request.origin?.host ?: ""
                    if (!host.endsWith("mangalamagro.in")) {
                        request.deny()
                        return@runOnUiThread
                    }
                    grantWebRequest(request, ask = true)
                }
            }

            override fun onShowFileChooser(view: WebView?, callback: ValueCallback<Array<Uri>>?,
                                           params: FileChooserParams?): Boolean {
                fileCallback?.onReceiveValue(null)
                fileCallback = callback
                if (params == null || !openFileChooser(params)) {
                    fileCallback = null
                    return false
                }
                return true
            }

            override fun onShowCustomView(view: View?, callback: CustomViewCallback?) {
                if (view == null) return
                if (fullView != null) { callback?.onCustomViewHidden(); return }
                fullView = view
                fullCallback = callback
                view.setBackgroundColor(android.graphics.Color.BLACK)
                (window.decorView as FrameLayout).addView(view, FrameLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
                WindowInsetsControllerCompat(window, window.decorView).apply {
                    hide(WindowInsetsCompat.Type.systemBars())
                    systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
                }
            }

            override fun onHideCustomView() { exitFullScreenVideo() }
        }

        // Download buttons (and files the WebView can't show) go to the phone's Downloads
        webView.setDownloadListener { url, userAgent, contentDisposition, mimeType, _ ->
            if (url.startsWith("blob:") || url.startsWith("data:")) return@setDownloadListener   // handled in the page (see injectDownloadHelper)
            downloadToPhone(url, userAgent, contentDisposition, mimeType)
        }

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
                if (handleSpecialUrl(url)) return true
                return super.shouldOverrideUrlLoading(view, request)
            }

            @Deprecated("Deprecated in Java")
            override fun shouldOverrideUrlLoading(view: WebView?, url: String?): Boolean {
                if (url != null && (url.startsWith("tel:") || url.contains("dialer"))) {
                    openPhoneApp(if (url.startsWith("tel:")) url.substring(4) else "")
                    return true
                }
                if (url != null && handleSpecialUrl(url)) return true
                @Suppress("DEPRECATION")
                return super.shouldOverrideUrlLoading(view, url)
            }

            override fun onPageFinished(view: WebView?, url: String?) {
                super.onPageFinished(view, url)
                injectDownloadHelper()
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

        // Opened from a notification (e.g. Answer on a WhatsApp call): go straight there
        val navPath = intent?.getStringExtra("nav_path")
        webView.loadUrl("https://crm.mangalamagro.in" + (if (!navPath.isNullOrEmpty()) navPath else "/chat"))
        intent?.removeExtra("nav_path")
    }

    private fun toast(msg: String) = Toast.makeText(this, msg, Toast.LENGTH_LONG).show()

    /** Grant the page the camera / microphone it asks for, asking Android first if needed. */
    private fun grantWebRequest(request: PermissionRequest, ask: Boolean) {
        val want = linkedMapOf(
            PermissionRequest.RESOURCE_AUDIO_CAPTURE to Manifest.permission.RECORD_AUDIO,
            PermissionRequest.RESOURCE_VIDEO_CAPTURE to Manifest.permission.CAMERA
        ).filterKeys { request.resources.contains(it) }
        if (want.isEmpty()) { request.deny(); return }
        fun has(p: String) = ContextCompat.checkSelfPermission(this, p) == PackageManager.PERMISSION_GRANTED
        val missing = want.values.filter { !has(it) }
        if (missing.isNotEmpty() && ask) {
            pendingWebRequest?.deny()
            pendingWebRequest = request
            webPermLauncher.launch(missing.toTypedArray())
            return
        }
        val ok = want.filterValues { has(it) }.keys
        if (ok.size < want.size) {
            val what = want.filterValues { !has(it) }.values.joinToString(" and ") {
                if (it == Manifest.permission.CAMERA) "Camera" else "Microphone"
            }
            toast("Allow $what for LeadOrbit: phone Settings > Apps > LeadOrbit > Permissions")
        }
        if (ok.isEmpty()) request.deny() else request.grant(ok.toTypedArray())
    }

    /** The phone's picker (gallery / files) for the page's attach buttons. */
    private fun openFileChooser(params: WebChromeClient.FileChooserParams): Boolean {
        val mimes = params.acceptTypes.flatMap { it.split(",") }.map { it.trim().lowercase() }.filter { it.isNotEmpty() }
            .map { t -> if (t.startsWith(".")) MimeTypeMap.getSingleton().getMimeTypeFromExtension(t.substring(1)) ?: "*/*" else t }
            .distinct()
        val pick = Intent(Intent.ACTION_GET_CONTENT).apply {
            addCategory(Intent.CATEGORY_OPENABLE)
            when {
                mimes.isEmpty() || mimes.contains("*/*") -> type = "*/*"
                mimes.size == 1 -> type = mimes[0]
                else -> { type = "*/*"; putExtra(Intent.EXTRA_MIME_TYPES, mimes.toTypedArray()) }
            }
            if (params.mode == WebChromeClient.FileChooserParams.MODE_OPEN_MULTIPLE) putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true)
        }
        return try {
            fileChooserLauncher.launch(Intent.createChooser(pick, "Choose"))
            true
        } catch (e: Exception) {
            Log.e("MainActivity", "file chooser: ${e.message}")
            false
        }
    }

    private fun exitFullScreenVideo() {
        val v = fullView ?: return
        (window.decorView as FrameLayout).removeView(v)
        fullView = null
        fullCallback?.onCustomViewHidden()
        fullCallback = null
        WindowInsetsControllerCompat(window, window.decorView).show(WindowInsetsCompat.Type.systemBars())
    }

    private fun isCrmFile(uri: Uri): Boolean {
        val host = uri.host ?: return false
        val path = uri.path ?: return false
        return host.endsWith("mangalamagro.in") && (path.startsWith("/api/media/") || path.startsWith("/api/uploads/"))
    }

    /** true = handled here, the WebView must not load it. */
    private fun handleSpecialUrl(url: String): Boolean {
        val uri = Uri.parse(url)
        val scheme = (uri.scheme ?: "").lowercase()
        if (scheme == "http" || scheme == "https") {
            if (isCrmFile(uri)) {
                // ?download=1 -> the server answers "attachment" -> DownloadListener saves it
                if (uri.getQueryParameter("download") == "1") return false
                openInApp(url)
                return true
            }
            if ((uri.host ?: "").endsWith("mangalamagro.in")) return false
            // other websites (maps, links in messages): the phone's browser / app
            try { startActivity(Intent(Intent.ACTION_VIEW, uri)) } catch (e: Exception) { }
            return true
        }
        if (scheme == "blob" || scheme == "data" || scheme == "javascript" || scheme == "about") return false
        // mailto:, whatsapp:, upi:, intent: ...
        try {
            val i = if (scheme == "intent") Intent.parseUri(url, Intent.URI_INTENT_SCHEME) else Intent(Intent.ACTION_VIEW, uri)
            startActivity(i)
        } catch (e: Exception) {
            toast("No app on this phone can open this link")
        }
        return true
    }

    private fun fileNameFrom(url: String, contentDisposition: String?, mime: String?): String {
        val cd = contentDisposition ?: ""
        Regex("filename\\*=UTF-8''([^;]+)", RegexOption.IGNORE_CASE).find(cd)?.let {
            val n = Uri.decode(it.groupValues[1]).trim()
            if (n.isNotEmpty()) return n.replace("/", "_")
        }
        return URLUtil.guessFileName(url, cd, mime).replace("/", "_")
    }

    /** Save a CRM file into the phone's Downloads (notification when done). */
    private fun downloadToPhone(url: String, userAgent: String?, contentDisposition: String?, mimeType: String?) {
        val name = fileNameFrom(url, contentDisposition, mimeType)
        try {
            val req = DownloadManager.Request(Uri.parse(url)).apply {
                CookieManager.getInstance().getCookie(url)?.let { addRequestHeader("Cookie", it) }
                addRequestHeader("User-Agent", userAgent ?: webView.settings.userAgentString)
                if (!mimeType.isNullOrEmpty()) setMimeType(mimeType)
                setTitle(name)
                setDescription("LeadOrbit")
                setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
                setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, "LeadOrbit/$name")
            }
            (getSystemService(Context.DOWNLOAD_SERVICE) as DownloadManager).enqueue(req)
            toast("Downloading $name - it will be in Downloads > LeadOrbit")
        } catch (e: Exception) {
            Log.e("MainActivity", "download failed: ${e.message}")
            toast("Download failed: ${e.message}")
        }
    }

    private fun saveBytesToDownloads(name: String, mime: String, bytes: ByteArray) {
        val safe = name.replace("/", "_")
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            val values = ContentValues().apply {
                put(MediaStore.MediaColumns.DISPLAY_NAME, safe)
                put(MediaStore.MediaColumns.MIME_TYPE, mime)
                put(MediaStore.MediaColumns.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS + "/LeadOrbit")
            }
            val uri = contentResolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values) ?: throw IllegalStateException("no uri")
            contentResolver.openOutputStream(uri)?.use { it.write(bytes) }
        } else {
            @Suppress("DEPRECATION")
            val dir = File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS), "LeadOrbit")
            dir.mkdirs()
            File(dir, safe).writeBytes(bytes)
        }
        runOnUiThread { toast("Saved $safe in Downloads > LeadOrbit") }
    }

    /** A document from a chat: fetch it, then open it in the phone's PDF / Word / Excel / image app. */
    private fun openInApp(url: String) {
        toast("Opening…")
        Thread {
            try {
                val client = OkHttpClient.Builder().readTimeout(60, TimeUnit.SECONDS).build()
                val reqB = Request.Builder().url(url)
                CookieManager.getInstance().getCookie(url)?.let { reqB.addHeader("Cookie", it) }
                client.newCall(reqB.build()).execute().use { resp ->
                    if (!resp.isSuccessful) throw IllegalStateException("HTTP ${resp.code}")
                    val type = resp.header("Content-Type")?.substringBefore(';')?.trim()
                    val name = fileNameFrom(url, resp.header("Content-Disposition"), type)
                    val ext = name.substringAfterLast('.', "").lowercase()
                    val mime = type?.takeIf { it.isNotEmpty() && it != "application/octet-stream" }
                        ?: MimeTypeMap.getSingleton().getMimeTypeFromExtension(ext) ?: "*/*"
                    val dir = File(cacheDir, "shared").apply { mkdirs() }
                    dir.listFiles()?.filter { System.currentTimeMillis() - it.lastModified() > 24 * 3600 * 1000L }?.forEach { it.delete() }
                    val f = File(dir, name)
                    resp.body?.byteStream()?.use { input -> f.outputStream().use { input.copyTo(it) } }
                    val uri = FileProvider.getUriForFile(this, "$packageName.fileprovider", f)
                    runOnUiThread {
                        val view = Intent(Intent.ACTION_VIEW).apply {
                            setDataAndType(uri, mime)
                            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                        }
                        try {
                            startActivity(Intent.createChooser(view, name).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION))
                        } catch (e: ActivityNotFoundException) {
                            toast("No app on this phone opens .$ext files - saving it to Downloads")
                            downloadToPhone(url, null, resp.header("Content-Disposition"), type)
                        }
                    }
                }
            } catch (e: Exception) {
                Log.e("MainActivity", "open file failed: ${e.message}")
                runOnUiThread { toast("Couldn't open the file: ${e.message}") }
            }
        }.start()
    }

    /** Links that save a file made inside the page (blob:/data:) - the WebView can't download those itself. */
    private fun injectDownloadHelper() {
        val js = """
            (function(){
              if (window.__loDl || !window.LeadOrbitNative) return; window.__loDl = 1;
              var rv = URL.revokeObjectURL;
              URL.revokeObjectURL = function(u){ setTimeout(function(){ try { rv.call(URL, u); } catch(e){} }, 60000); };
              function hit(a){ return a && a.href && a.hasAttribute && a.hasAttribute('download') && (a.href.indexOf('blob:') === 0 || a.href.indexOf('data:') === 0); }
              function save(a){
                var name = a.getAttribute('download') || 'download';
                fetch(a.href).then(function(r){ return r.blob(); }).then(function(b){
                  var fr = new FileReader();
                  fr.onload = function(){ LeadOrbitNative.saveDataUrl(String(fr.result), name, b.type || ''); };
                  fr.readAsDataURL(b);
                });
              }
              var oc = HTMLAnchorElement.prototype.click;
              HTMLAnchorElement.prototype.click = function(){ if (hit(this)) { save(this); return; } return oc.apply(this, arguments); };
              document.addEventListener('click', function(e){
                var a = e.target && e.target.closest ? e.target.closest('a') : null;
                if (hit(a)) { e.preventDefault(); e.stopPropagation(); save(a); }
              }, true);
            })();
        """.trimIndent()
        webView.evaluateJavascript(js, null)
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
        if (fullView != null) {
            exitFullScreenVideo()
        } else if (webView.canGoBack()) {
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
        prepareForCall(intent)
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
        try { unregisterReceiver(hangupReceiver) } catch (e: Exception) { }
        if (inCall) try { resetCallAudio() } catch (e: Exception) { }
        try { proximityLock?.let { if (it.isHeld) it.release() } } catch (e: Exception) { }
    }
}
