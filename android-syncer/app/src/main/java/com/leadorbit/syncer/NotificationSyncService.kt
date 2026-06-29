package com.leadorbit.syncer

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.SharedPreferences
import android.media.AudioAttributes
import android.media.MediaPlayer
import android.media.RingtoneManager
import android.os.Build
import android.os.IBinder
import android.util.Log
import androidx.core.app.NotificationCompat
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import okhttp3.MediaType.Companion.toMediaTypeOrNull
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONObject
import java.util.concurrent.TimeUnit

class NotificationSyncService : Service() {

    companion object {
        private const val TAG = "NotificationSyncService"
        
        // Actions
        const val ACTION_START = "com.leadorbit.syncer.START"
        const val ACTION_ACK_ALERT = "com.leadorbit.syncer.ACK_ALERT"
        const val ACTION_DONE_FOLLOWUP = "com.leadorbit.syncer.DONE_FOLLOWUP"
        const val ACTION_SNOOZE_FOLLOWUP = "com.leadorbit.syncer.SNOOZE_FOLLOWUP"

        // Channels
        private const val CHANNEL_BG_ID = "leadorbit_sync_channel"
        private const val CHANNEL_ALERT_ID = "leadorbit_alert_channel"
        
        // Notification IDs
        private const val NOTIFICATION_BG_ID = 999
    }

    private lateinit var sharedPrefs: SharedPreferences
    private var webSocket: WebSocket? = null
    private val client = OkHttpClient.Builder()
        .readTimeout(0, TimeUnit.MILLISECONDS) // Keep connection alive indefinitely
        .build()

    // Repeating Alarm Player
    private var mediaPlayer: MediaPlayer? = null

    // WakeLock to keep WebSocket active
    private var wakeLock: android.os.PowerManager.WakeLock? = null

    // Track active ringing items to manage alarm loop state
    private val activeAlertIds = mutableSetOf<String>()
    private val activeFollowupIds = mutableSetOf<String>()

    private var isConnecting = false
    private var userId: String? = null
    private var token: String? = null

    override fun onCreate() {
        super.onCreate()
        sharedPrefs = getSharedPreferences("CRM_PREFS", Context.MODE_PRIVATE)
        createNotificationChannels()
        
        try {
            val powerManager = getSystemService(Context.POWER_SERVICE) as android.os.PowerManager
            wakeLock = powerManager.newWakeLock(android.os.PowerManager.PARTIAL_WAKE_LOCK, "LeadOrbit::SyncWakeLock").apply {
                acquire()
            }
            Log.i(TAG, "WakeLock acquired.")
        } catch (e: Exception) {
            Log.e(TAG, "Failed to acquire WakeLock", e)
        }
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val action = intent?.action
        Log.d(TAG, "onStartCommand action: $action")

        if (intent == null || action == ACTION_START) {
            startForegroundService()
            initializeWebSocketConnection()
        } else {
            when (action) {
                ACTION_ACK_ALERT -> {
                    val alertId = intent.getStringExtra("alert_id")
                    if (alertId != null) {
                        acknowledgeAlertOnBackend(alertId)
                    }
                }
                ACTION_DONE_FOLLOWUP -> {
                    val fuId = intent.getStringExtra("fu_id")
                    if (fuId != null) {
                        markFollowupDoneOnBackend(fuId)
                    }
                }
                ACTION_SNOOZE_FOLLOWUP -> {
                    val fuId = intent.getStringExtra("fu_id")
                    if (fuId != null) {
                        snoozeFollowupOnBackend(fuId)
                    }
                }
            }
        }

        return START_STICKY
    }

    private fun startForegroundService() {
        val notificationIntent = Intent(this, MainActivity::class.java)
        val pendingIntent = PendingIntent.getActivity(
            this, 0, notificationIntent,
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        )

        val notification = NotificationCompat.Builder(this, CHANNEL_BG_ID)
            .setContentTitle("LeadOrbit Sync Active")
            .setContentText("Monitoring alerts and reminders in the background")
            .setSmallIcon(R.drawable.ic_launcher)
            .setContentIntent(pendingIntent)
            .setOngoing(true)
            .setCategory(Notification.CATEGORY_SERVICE)
            .build()

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            startForeground(
                NOTIFICATION_BG_ID,
                notification,
                android.content.pm.ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC
            )
        } else {
            startForeground(NOTIFICATION_BG_ID, notification)
        }
    }

    private fun initializeWebSocketConnection() {
        userId = sharedPrefs.getString("user_id", null)
        token = sharedPrefs.getString("auth_token", null)

        if (userId == null || token == null) {
            Log.w(TAG, "Credentials missing. Stopping service.")
            stopSelf()
            return
        }

        if (webSocket != null || isConnecting) return

        isConnecting = true
        connectWebSocket()
    }

    private fun connectWebSocket() {
        val wsUrl = "wss://crm.mangalamagro.in/api/ws/$userId?token=$token"
        val request = Request.Builder().url(wsUrl).build()

        webSocket = client.newWebSocket(request, object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: okhttp3.Response) {
                Log.i(TAG, "WebSocket connected successfully.")
                isConnecting = false
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                Log.d(TAG, "WebSocket message: $text")
                try {
                    val json = JSONObject(text)
                    val type = json.optString("type")
                    val action = json.optString("action")

                    when (type) {
                        "admin_alert" -> {
                            if (action == "trigger") {
                                val alert = json.optJSONObject("alert")
                                if (alert != null) {
                                    handleAdminAlertTrigger(alert)
                                }
                            } else if (action == "clear") {
                                val alertId = json.optString("alert_id")
                                if (alertId.isNotEmpty()) {
                                    handleAdminAlertClear(alertId)
                                }
                            }
                        }
                        "followup" -> {
                            if (action == "trigger") {
                                val followup = json.optJSONObject("followup")
                                if (followup != null) {
                                    handleFollowupTrigger(followup)
                                }
                            } else if (action == "clear") {
                                val fuId = json.optString("fu_id")
                                if (fuId.isNotEmpty()) {
                                    handleFollowupClear(fuId)
                                }
                            }
                        }
                    }
                } catch (e: Exception) {
                    Log.e(TAG, "Error parsing WebSocket message", e)
                }
            }

            override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                Log.w(TAG, "WebSocket closing: $code / $reason")
                webSocket.close(1000, null)
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                Log.w(TAG, "WebSocket closed. Retrying...")
                this@NotificationSyncService.webSocket = null
                isConnecting = false
                retryConnection()
            }

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: okhttp3.Response?) {
                Log.e(TAG, "WebSocket failure: ${t.message}", t)
                this@NotificationSyncService.webSocket = null
                isConnecting = false
                retryConnection()
            }
        })
    }

    private fun retryConnection() {
        CoroutineScope(Dispatchers.IO).launch {
            kotlinx.coroutines.delay(5000)
            if (webSocket == null && !isConnecting) {
                Log.d(TAG, "Retrying WebSocket connection...")
                initializeWebSocketConnection()
            }
        }
    }

    // --- Admin Alerts Handling ---

    private fun handleAdminAlertTrigger(alert: JSONObject) {
        val alertId = alert.optString("id")
        val title = alert.optString("title")
        val message = alert.optString("message")
        val sentBy = alert.optString("sent_by")

        synchronized(activeAlertIds) {
            activeAlertIds.add(alertId)
            startAlarmSound()
        }

        // Acknowledge Action Intent
        val ackIntent = Intent(this, NotificationSyncService::class.java).apply {
            action = ACTION_ACK_ALERT
            putExtra("alert_id", alertId)
        }
        val ackPendingIntent = PendingIntent.getService(
            this, alertId.hashCode(), ackIntent,
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        )

        // Main Tap Intent (Opens Main App)
        val mainIntent = Intent(this, MainActivity::class.java)
        val mainPendingIntent = PendingIntent.getActivity(
            this, alertId.hashCode() + 1, mainIntent,
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        )

        val notification = NotificationCompat.Builder(this, CHANNEL_ALERT_ID)
            .setContentTitle("Urgent Alert: $title")
            .setContentText(message)
            .setStyle(NotificationCompat.BigTextStyle().bigText("$message\n\nFrom: $sentBy"))
            .setSmallIcon(R.drawable.ic_launcher)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setCategory(NotificationCompat.CATEGORY_ALARM)
            .setFullScreenIntent(mainPendingIntent, true)
            .addAction(R.drawable.ic_launcher, "Acknowledge", ackPendingIntent)
            .setAutoCancel(false)
            .setOngoing(true)
            .build()

        val manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        // ID is hash of alertId string to separate multiple concurrent alerts
        manager.notify(alertId.hashCode(), notification)
    }

    private fun handleAdminAlertClear(alertId: String) {
        synchronized(activeAlertIds) {
            activeAlertIds.remove(alertId)
            checkAlarmState()
        }
        val manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        manager.cancel(alertId.hashCode())
    }

    private fun acknowledgeAlertOnBackend(alertId: String) {
        handleAdminAlertClear(alertId)
        val token = sharedPrefs.getString("auth_token", null) ?: return
        
        CoroutineScope(Dispatchers.IO).launch {
            try {
                val request = Request.Builder()
                    .url("https://crm.mangalamagro.in/api/admin/alerts/$alertId/acknowledge")
                    .put("".toRequestBody())
                    .header("Authorization", "Bearer $token")
                    .build()
                client.newCall(request).execute().use { response ->
                    Log.d(TAG, "Acknowledge response: ${response.code}")
                }
            } catch (e: Exception) {
                Log.e(TAG, "Failed to acknowledge alert on server", e)
            }
        }
    }

    // --- Followup Reminders Handling ---

    private fun handleFollowupTrigger(followup: JSONObject) {
        val fuId = followup.optString("id")
        val leadName = followup.optString("lead_customer_name", "Lead")
        val note = followup.optString("note", "")

        synchronized(activeFollowupIds) {
            activeFollowupIds.add(fuId)
            startAlarmSound()
        }

        // Done Action Intent
        val doneIntent = Intent(this, NotificationSyncService::class.java).apply {
            action = ACTION_DONE_FOLLOWUP
            putExtra("fu_id", fuId)
        }
        val donePendingIntent = PendingIntent.getService(
            this, fuId.hashCode(), doneIntent,
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        )

        // Snooze Action Intent
        val snoozeIntent = Intent(this, NotificationSyncService::class.java).apply {
            action = ACTION_SNOOZE_FOLLOWUP
            putExtra("fu_id", fuId)
        }
        val snoozePendingIntent = PendingIntent.getService(
            this, fuId.hashCode() + 1, snoozeIntent,
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        )

        // Main Tap Intent (Opens Main App)
        val mainIntent = Intent(this, MainActivity::class.java)
        val mainPendingIntent = PendingIntent.getActivity(
            this, fuId.hashCode() + 2, mainIntent,
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        )

        val desc = if (note.isNotEmpty()) "Note: $note" else "Follow-up is due now"
        val notification = NotificationCompat.Builder(this, CHANNEL_ALERT_ID)
            .setContentTitle("Follow-up: $leadName")
            .setContentText(desc)
            .setSmallIcon(R.drawable.ic_launcher)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setCategory(NotificationCompat.CATEGORY_ALARM)
            .setFullScreenIntent(mainPendingIntent, true)
            .addAction(R.drawable.ic_launcher, "Mark Done", donePendingIntent)
            .addAction(R.drawable.ic_launcher, "Snooze 30m", snoozePendingIntent)
            .setAutoCancel(false)
            .setOngoing(true)
            .build()

        val manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        manager.notify(fuId.hashCode(), notification)
    }

    private fun handleFollowupClear(fuId: String) {
        synchronized(activeFollowupIds) {
            activeFollowupIds.remove(fuId)
            checkAlarmState()
        }
        val manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        manager.cancel(fuId.hashCode())
    }

    private fun markFollowupDoneOnBackend(fuId: String) {
        handleFollowupClear(fuId)
        val token = sharedPrefs.getString("auth_token", null) ?: return

        CoroutineScope(Dispatchers.IO).launch {
            try {
                val json = JSONObject().put("status", "done")
                val request = Request.Builder()
                    .url("https://crm.mangalamagro.in/api/followups/$fuId")
                    .patch(json.toString().toRequestBody("application/json".toMediaTypeOrNull()))
                    .header("Authorization", "Bearer $token")
                    .build()
                client.newCall(request).execute().use { response ->
                    Log.d(TAG, "Done followup response: ${response.code}")
                }
            } catch (e: Exception) {
                Log.e(TAG, "Failed to mark followup done on server", e)
            }
        }
    }

    private fun snoozeFollowupOnBackend(fuId: String) {
        handleFollowupClear(fuId)
        val token = sharedPrefs.getString("auth_token", null) ?: return

        CoroutineScope(Dispatchers.IO).launch {
            try {
                val request = Request.Builder()
                    .url("https://crm.mangalamagro.in/api/followups/$fuId/snooze")
                    .put("".toRequestBody())
                    .header("Authorization", "Bearer $token")
                    .build()
                client.newCall(request).execute().use { response ->
                    Log.d(TAG, "Snooze response: ${response.code}")
                }
            } catch (e: Exception) {
                Log.e(TAG, "Failed to snooze followup on server", e)
            }
        }
    }

    // --- Audio alarm controller ---

    private fun startAlarmSound() {
        if (mediaPlayer != null) return
        try {
            val alertUri = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_ALARM)
                ?: RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE)
            mediaPlayer = MediaPlayer().apply {
                setDataSource(this@NotificationSyncService, alertUri)
                setAudioAttributes(
                    AudioAttributes.Builder()
                        .setUsage(AudioAttributes.USAGE_ALARM)
                        .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                        .build()
                )
                isLooping = true
                prepare()
                start()
            }
            Log.i(TAG, "Alarm sound started playing.")
        } catch (e: Exception) {
            Log.e(TAG, "Error starting alarm sound", e)
        }
    }

    private fun stopAlarmSound() {
        mediaPlayer?.let {
            try {
                it.stop()
                it.release()
                Log.i(TAG, "Alarm sound stopped.")
            } catch (e: Exception) {
                Log.e(TAG, "Error stopping alarm sound", e)
            }
            mediaPlayer = null
        }
    }

    private fun checkAlarmState() {
        if (activeAlertIds.isEmpty() && activeFollowupIds.isEmpty()) {
            stopAlarmSound()
        }
    }

    // --- Channels Setup ---

    private fun createNotificationChannels() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            
            // Background service channel
            val bgChannel = NotificationChannel(
                CHANNEL_BG_ID,
                "LeadOrbit Background Sync",
                NotificationManager.IMPORTANCE_LOW
            ).apply {
                description = "Keeps connection open for alerts and reminders"
            }
            manager.createNotificationChannel(bgChannel)

            // High priority alert channel
            val alertChannel = NotificationChannel(
                CHANNEL_ALERT_ID,
                "LeadOrbit Alerts & Reminders",
                NotificationManager.IMPORTANCE_HIGH
            ).apply {
                description = "Ringing alert notifications for admin updates and due follow-ups"
                enableLights(true)
                enableVibration(true)
                // Sound is handled manually by MediaPlayer loop so channel sound can be default or silent to avoid overlapping double plays
                setSound(null, null)
            }
            manager.createNotificationChannel(alertChannel)
        }
    }

    override fun onDestroy() {
        super.onDestroy()
        Log.w(TAG, "Service onDestroy called. Closing connections and alarm.")
        webSocket?.close(1000, "Service destroyed")
        stopAlarmSound()
        
        try {
            wakeLock?.let {
                if (it.isHeld) {
                    it.release()
                    Log.i(TAG, "WakeLock released.")
                }
            }
        } catch (e: Exception) {
            Log.e(TAG, "Failed to release WakeLock", e)
        }
        wakeLock = null
    }
}
