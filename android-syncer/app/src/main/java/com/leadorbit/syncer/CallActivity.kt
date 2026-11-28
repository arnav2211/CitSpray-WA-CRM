package com.leadorbit.syncer

import android.Manifest
import android.annotation.SuppressLint
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.media.AudioDeviceCallback
import android.media.AudioDeviceInfo
import android.media.AudioManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.PowerManager
import android.util.Log
import android.view.ViewGroup
import android.view.WindowManager
import android.webkit.JavascriptInterface
import android.webkit.PermissionRequest
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import java.lang.ref.WeakReference

/**
 * The WhatsApp call runs in THIS window, not in the main app window.
 *
 * It is its own task (own taskAffinity, not in the recent-apps list), so swiping LeadOrbit
 * away from recents closes only the main window - the call, its WebView and audio carry on,
 * kept alive by OngoingCallService (foreground "call in progress" notification).
 * "Minimize" / "Chat" bring the main app to the front; the notification, the green bar in
 * the app and LeadOrbitNative.openCall() bring this window back.
 */
class CallActivity : AppCompatActivity() {

    companion object {
        private const val TAG = "CallActivity"
        const val BASE = "https://crm.mangalamagro.in"
        private var current: WeakReference<CallActivity>? = null

        /** Open (or bring back) the call window. path = "/wa-call/<id>?answer=1" or "/wa-call-out/<lead>"; null = just show it. */
        fun intent(ctx: Context, path: String?, callId: String? = null): Intent =
            Intent(ctx, CallActivity::class.java).apply {
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                if (path != null) putExtra("path", path)
                if (callId != null) putExtra("wa_call_id", callId)
            }

        fun live(): CallActivity? = current?.get()?.takeIf { !it.isFinishing && !it.isDestroyed }

        /** A call is going on in the call window right now. */
        fun inCallNow(): Boolean = live()?.inCall == true || live()?.callActive == true
    }

    private lateinit var webView: WebView
    private val handler = Handler(Looper.getMainLooper())
    private var loadedPath: String? = null
    @Volatile var callActive = false          // the page said "active" (call connected)
    private var proximityLock: PowerManager.WakeLock? = null

    // ---- audio routing (same behaviour as the old in-app call screen) ----
    private var callRoute = "speaker"
    private var autoRoute = true
    @Volatile var inCall = false
    private val audioDeviceCallback = object : AudioDeviceCallback() {
        override fun onAudioDevicesAdded(addedDevices: Array<out AudioDeviceInfo>) { onRoutesChanged() }
        override fun onAudioDevicesRemoved(removedDevices: Array<out AudioDeviceInfo>) { onRoutesChanged() }
    }

    private var pendingMic: PermissionRequest? = null
    private val micLauncher = registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        pendingMic?.let { if (granted) it.grant(arrayOf(PermissionRequest.RESOURCE_AUDIO_CAPTURE)) else it.deny() }
        pendingMic = null
    }

    private val hangupReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) {
            js("window.__waCallHangup && window.__waCallHangup()")
        }
    }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val path = intent?.getStringExtra("path")
        if (path.isNullOrEmpty()) {          // "return to call" but there is no call window any more
            openMainApp(null)
            finish()
            return
        }
        current = WeakReference(this)
        showOverLockScreen()
        stopRinging(intent)

        webView = WebView(this)
        webView.setBackgroundColor(0xFF075E54.toInt())
        setContentView(FrameLayout(this).apply {
            setBackgroundColor(0xFF075E54.toInt())
            addView(webView, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        })
        webView.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            databaseEnabled = true
            cacheMode = WebSettings.LOAD_DEFAULT
            mediaPlaybackRequiresUserGesture = false
        }
        webView.addJavascriptInterface(Bridge(), "LeadOrbitNative")
        webView.webChromeClient = object : WebChromeClient() {
            override fun onPermissionRequest(request: PermissionRequest) {
                runOnUiThread {
                    if (!(request.origin?.host ?: "").endsWith("mangalamagro.in") ||
                        !request.resources.contains(PermissionRequest.RESOURCE_AUDIO_CAPTURE)) {
                        request.deny(); return@runOnUiThread
                    }
                    if (ContextCompat.checkSelfPermission(this@CallActivity, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) {
                        request.grant(arrayOf(PermissionRequest.RESOURCE_AUDIO_CAPTURE))
                    } else {
                        pendingMic?.deny()
                        pendingMic = request
                        micLauncher.launch(Manifest.permission.RECORD_AUDIO)
                    }
                }
            }
        }
        webView.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView?, request: WebResourceRequest?): Boolean =
                handleUrl(request?.url?.toString() ?: "")

            @Deprecated("Deprecated in Java")
            override fun shouldOverrideUrlLoading(view: WebView?, url: String?): Boolean = handleUrl(url ?: "")
        }
        ContextCompat.registerReceiver(this, hangupReceiver, IntentFilter(OngoingCallService.HANGUP_BROADCAST),
            ContextCompat.RECEIVER_NOT_EXPORTED)
        load(path)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        stopRinging(intent)
        val path = intent.getStringExtra("path")
        // during a call never replace it; otherwise open the new call screen
        if (!path.isNullOrEmpty() && path != loadedPath && !inCallNow()) {
            showOverLockScreen()
            load(path)
        }
    }

    private fun load(path: String) {
        loadedPath = path
        webView.loadUrl(BASE + path)
    }

    /** The call page only; anything else in the CRM opens in the main app window. */
    private fun handleUrl(url: String): Boolean {
        val uri = Uri.parse(url)
        val host = uri.host ?: ""
        if (!host.endsWith("mangalamagro.in")) return true
        val p = uri.path ?: "/"
        if (p.startsWith("/wa-call")) return false
        val full = p + (uri.query?.let { "?$it" } ?: "")
        openMainApp(full)
        if (!inCallNow()) finish()
        return true
    }

    private fun openMainApp(path: String?) {
        try {
            startActivity(Intent(this, MainActivity::class.java).apply {
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_REORDER_TO_FRONT)
                if (!path.isNullOrEmpty()) putExtra("nav_path", path)
            })
        } catch (e: Exception) {
            Log.w(TAG, "open main app: ${e.message}")
        }
    }

    private fun showOverLockScreen() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
            setShowWhenLocked(true)
            setTurnScreenOn(true)
        } else {
            @Suppress("DEPRECATION")
            window.addFlags(WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED or WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON)
        }
    }

    private fun stopRinging(i: Intent?) {
        val callId = i?.getStringExtra("wa_call_id") ?: return
        WaCallNotifier.clear(this, callId)
        try {
            startService(Intent(this, NotificationSyncService::class.java).apply {
                action = NotificationSyncService.ACTION_WA_STOP_RING
                putExtra("call_id", callId)
            })
        } catch (e: Exception) { }
    }

    private fun js(code: String) {
        runOnUiThread { try { webView.evaluateJavascript(code, null) } catch (e: Exception) { } }
    }

    private fun routeOf(type: Int): String? = when (type) {
        AudioDeviceInfo.TYPE_BLUETOOTH_SCO -> "bluetooth"
        AudioDeviceInfo.TYPE_WIRED_HEADSET, AudioDeviceInfo.TYPE_WIRED_HEADPHONES, AudioDeviceInfo.TYPE_USB_HEADSET -> "wired"
        AudioDeviceInfo.TYPE_BUILTIN_SPEAKER -> "speaker"
        AudioDeviceInfo.TYPE_BUILTIN_EARPIECE -> "earpiece"
        else -> if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S && type == AudioDeviceInfo.TYPE_BLE_HEADSET) "bluetooth" else null
    }

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
            routes[r]?.let { am.setCommunicationDevice(it) }
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
        try {
            if (r == "earpiece") proximityLock?.let { if (!it.isHeld) it.acquire(3 * 3600 * 1000L) }
            else proximityLock?.let { if (it.isHeld) it.release() }
        } catch (e: Exception) { }
        js("window.__waAudioRoute && window.__waAudioRoute('$r', '${routes.keys.joinToString(",")}')")
    }

    private fun onRoutesChanged() {
        if (!inCall) return
        runOnUiThread {
            val am = getSystemService(Context.AUDIO_SERVICE) as AudioManager
            val routes = availableRoutes(am)
            if (autoRoute || !routes.containsKey(callRoute)) applyRoute(autoChoice(routes))
            else js("window.__waAudioRoute && window.__waAudioRoute('$callRoute', '${routes.keys.joinToString(",")}')")
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

    /** LeadOrbitNative inside the call window. */
    inner class Bridge {
        @JavascriptInterface
        fun isCallWindow(): Boolean = true

        /** Bring the main app to the front (optionally at a CRM path); the call keeps going here. */
        @JavascriptInterface
        fun showApp(path: String) {
            runOnUiThread { openMainApp(path.ifEmpty { null }) }
        }

        /** The call is over and the user is done with this screen. */
        @JavascriptInterface
        fun closeCall(path: String) {
            runOnUiThread {
                openMainApp(path.ifEmpty { null })
                if (!callActive) finish()
            }
        }

        @JavascriptInterface
        fun callState(state: String, name: String) {
            runOnUiThread {
                if (state == "active") {
                    callActive = true
                    window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
                    OngoingCallService.start(this@CallActivity, name)
                    try {
                        val pm = getSystemService(Context.POWER_SERVICE) as PowerManager
                        if (pm.isWakeLockLevelSupported(PowerManager.PROXIMITY_SCREEN_OFF_WAKE_LOCK) && proximityLock == null) {
                            proximityLock = pm.newWakeLock(PowerManager.PROXIMITY_SCREEN_OFF_WAKE_LOCK, "LeadOrbit:waCall").apply { acquire(3 * 3600 * 1000L) }
                        }
                    } catch (e: Exception) { }
                } else {
                    callActive = false
                    window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
                    OngoingCallService.stop(this@CallActivity)
                    try { proximityLock?.let { if (it.isHeld) it.release() } } catch (e: Exception) { }
                    proximityLock = null
                    resetCallAudio()
                }
            }
        }

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

        @JavascriptInterface
        fun audioRoutes(): String {
            val am = getSystemService(Context.AUDIO_SERVICE) as AudioManager
            val routes = availableRoutes(am).keys
            return "{\"route\":\"$callRoute\",\"routes\":[" + routes.joinToString(",") { "\"$it\"" } + "]}"
        }

        @Suppress("DEPRECATION")
        @JavascriptInterface
        fun setSpeaker(on: Boolean) {
            runOnUiThread {
                val am = getSystemService(Context.AUDIO_SERVICE) as AudioManager
                am.mode = AudioManager.MODE_IN_COMMUNICATION
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                    val type = if (on) AudioDeviceInfo.TYPE_BUILTIN_SPEAKER else AudioDeviceInfo.TYPE_BUILTIN_EARPIECE
                    val dev = am.availableCommunicationDevices.firstOrNull { it.type == type }
                    if (dev != null) am.setCommunicationDevice(dev) else am.isSpeakerphoneOn = on
                } else {
                    am.isSpeakerphoneOn = on
                }
                try {
                    if (on) proximityLock?.let { if (it.isHeld) it.release() }
                    else proximityLock?.let { if (!it.isHeld) it.acquire(3 * 3600 * 1000L) }
                } catch (e: Exception) { }
            }
        }
    }

    /** Back during a call = go to the app, the call continues (like a phone app). */
    @Deprecated("Deprecated in Java")
    override fun onBackPressed() {
        if (callActive || inCall) {
            openMainApp(null)
        } else {
            openMainApp(null)
            finish()
        }
    }

    override fun onDestroy() {
        try { unregisterReceiver(hangupReceiver) } catch (e: Exception) { }
        if (callActive || inCall) {
            // the window is going away for good - end the call cleanly instead of leaving it dangling
            try { OngoingCallService.stop(this) } catch (e: Exception) { }
            try { resetCallAudio() } catch (e: Exception) { }
        }
        try { proximityLock?.let { if (it.isHeld) it.release() } } catch (e: Exception) { }
        if (current?.get() === this) current = null
        if (::webView.isInitialized) {
            try { webView.destroy() } catch (e: Exception) { }
        }
        super.onDestroy()
    }
}
