package com.leadorbit.syncer

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.media.AudioAttributes
import android.media.AudioManager
import android.media.MediaPlayer
import android.media.RingtoneManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager
import android.provider.Settings
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.app.Person
import org.json.JSONObject

/**
 * Incoming WhatsApp call ringing on this phone - works with the app closed, because
 * NotificationSyncService (a foreground service) receives the ring over its WebSocket.
 *  - an incoming-call notification (heads-up, Answer / Decline) on every phone
 *  - a full-screen ringing screen over the lock screen (full-screen intent) and,
 *    when "Display over other apps" is allowed, over whatever app is open
 *  - the phone's ringtone + vibration, like a normal call; stops after 60 s
 */
object WaCallNotifier {
    private const val TAG = "WaCallNotifier"
    const val CHANNEL_CALL = "leadorbit_wa_call_channel"
    const val CHANNEL_INFO = "leadorbit_wa_info_channel"
    const val ACTION_CLEAR_BROADCAST = "com.leadorbit.syncer.WA_CALL_CLEARED"
    private const val RING_TIMEOUT_MS = 60_000L

    private var player: MediaPlayer? = null
    private var vibrator: Vibrator? = null
    private val ringing = mutableMapOf<String, JSONObject>()
    private val handler = Handler(Looper.getMainLooper())

    fun notifId(callId: String) = ("wacall:$callId").hashCode()

    fun ensureChannels(ctx: Context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val nm = ctx.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        nm.createNotificationChannel(NotificationChannel(CHANNEL_CALL, "WhatsApp calls", NotificationManager.IMPORTANCE_HIGH).apply {
            description = "Incoming WhatsApp calls to the company number"
            lockscreenVisibility = Notification.VISIBILITY_PUBLIC
            setSound(null, null)          // the ringtone is played by the app (loops like a real call)
            enableVibration(false)
        })
        nm.createNotificationChannel(NotificationChannel(CHANNEL_INFO, "WhatsApp call approvals", NotificationManager.IMPORTANCE_HIGH).apply {
            description = "Requests to make a WhatsApp call, approvals and customers allowing calls"
            lockscreenVisibility = Notification.VISIBILITY_PUBLIC
        })
    }

    fun isRinging(callId: String) = synchronized(ringing) { ringing.containsKey(callId) }

    fun callInfo(callId: String): JSONObject? = synchronized(ringing) { ringing[callId] }

    fun ring(ctx: Context, call: JSONObject) {
        val callId = call.optString("id")
        if (callId.isEmpty()) return
        synchronized(ringing) {
            if (ringing.containsKey(callId)) return
            ringing[callId] = call
        }
        ensureChannels(ctx)
        val name = call.optString("name").ifEmpty { call.optString("from") }.ifEmpty { "WhatsApp caller" }
        val company = if (call.optString("company") == "fragvansh") "Fragvansh" else "CitSpray"

        val fullScreen = PendingIntent.getActivity(ctx, notifId(callId),
            IncomingCallActivity.intent(ctx, callId, name, call.optString("from"), company),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        val answer = PendingIntent.getActivity(ctx, notifId(callId) + 1, answerIntent(ctx, callId),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        val decline = PendingIntent.getService(ctx, notifId(callId) + 2,
            Intent(ctx, NotificationSyncService::class.java).apply {
                action = NotificationSyncService.ACTION_WA_DECLINE
                putExtra("call_id", callId)
            }, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)

        val builder = NotificationCompat.Builder(ctx, CHANNEL_CALL)
            .setSmallIcon(R.drawable.ic_call_incoming)
            .setContentTitle(name)
            .setContentText("WhatsApp call · $company")
            .setPriority(NotificationCompat.PRIORITY_MAX)
            .setCategory(NotificationCompat.CATEGORY_CALL)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .setOngoing(true)
            .setAutoCancel(false)
            .setTimeoutAfter(RING_TIMEOUT_MS)
            .setContentIntent(fullScreen)
            .setFullScreenIntent(fullScreen, true)
        try {
            val person = Person.Builder().setName(name).setImportant(true).build()
            builder.setStyle(NotificationCompat.CallStyle.forIncomingCall(person, decline, answer))
        } catch (e: Exception) {
            builder.addAction(R.drawable.ic_call_end, "Decline", decline)
            builder.addAction(R.drawable.ic_call_answer, "Answer", answer)
        }
        val nm = ctx.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        try {
            nm.notify(notifId(callId), builder.build())
        } catch (e: Exception) {
            Log.e(TAG, "call-style notification failed, using a plain one", e)
            val plain = NotificationCompat.Builder(ctx, CHANNEL_CALL)
                .setSmallIcon(R.drawable.ic_call_incoming).setContentTitle(name).setContentText("WhatsApp call · $company")
                .setPriority(NotificationCompat.PRIORITY_MAX).setCategory(NotificationCompat.CATEGORY_CALL)
                .setOngoing(true).setTimeoutAfter(RING_TIMEOUT_MS).setContentIntent(fullScreen).setFullScreenIntent(fullScreen, true)
                .addAction(R.drawable.ic_call_end, "Decline", decline).addAction(R.drawable.ic_call_answer, "Answer", answer)
            nm.notify(notifId(callId), plain.build())
        }

        // Over other apps too (when allowed); the full-screen intent covers the lock screen
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M || Settings.canDrawOverlays(ctx)) {
            try {
                ctx.startActivity(IncomingCallActivity.intent(ctx, callId, name, call.optString("from"), company)
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
            } catch (e: Exception) {
                Log.w(TAG, "could not open the ringing screen: ${e.message}")
            }
        }
        startRinging(ctx)
        handler.postDelayed({ clear(ctx, callId) }, RING_TIMEOUT_MS)
    }

    fun answerIntent(ctx: Context, callId: String): Intent =
        Intent(ctx, MainActivity::class.java).apply {
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP)
            putExtra("nav_path", "/wa-call/$callId?answer=1")
            putExtra("wa_call_id", callId)
        }

    /** Stop ringing for this call on this phone (answered here / elsewhere, declined, ended). */
    fun clear(ctx: Context, callId: String) {
        val had = synchronized(ringing) { ringing.remove(callId) != null }
        val nm = ctx.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        nm.cancel(notifId(callId))
        if (synchronized(ringing) { ringing.isEmpty() }) stopRinging()
        if (had) {
            ctx.sendBroadcast(Intent(ACTION_CLEAR_BROADCAST).setPackage(ctx.packageName).putExtra("call_id", callId))
        }
    }

    private fun startRinging(ctx: Context) {
        val am = ctx.getSystemService(Context.AUDIO_SERVICE) as AudioManager
        if (player == null && am.ringerMode == AudioManager.RINGER_MODE_NORMAL) {
            try {
                val uri = RingtoneManager.getActualDefaultRingtoneUri(ctx, RingtoneManager.TYPE_RINGTONE)
                    ?: RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE)
                player = MediaPlayer().apply {
                    setDataSource(ctx, uri)
                    setAudioAttributes(AudioAttributes.Builder()
                        .setUsage(AudioAttributes.USAGE_NOTIFICATION_RINGTONE)
                        .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION).build())
                    isLooping = true
                    prepare()
                    start()
                }
            } catch (e: Exception) {
                Log.e(TAG, "ringtone failed", e)
                player = null
            }
        }
        if (vibrator == null && am.ringerMode != AudioManager.RINGER_MODE_SILENT) {
            try {
                val v = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S)
                    (ctx.getSystemService(Context.VIBRATOR_MANAGER_SERVICE) as VibratorManager).defaultVibrator
                else @Suppress("DEPRECATION") (ctx.getSystemService(Context.VIBRATOR_SERVICE) as Vibrator)
                val pattern = longArrayOf(0, 1000, 1000)
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) v.vibrate(VibrationEffect.createWaveform(pattern, 0))
                else @Suppress("DEPRECATION") v.vibrate(pattern, 0)
                vibrator = v
            } catch (e: Exception) {
                Log.e(TAG, "vibrate failed", e)
            }
        }
    }

    private fun stopRinging() {
        try { player?.stop(); player?.release() } catch (e: Exception) { }
        player = null
        try { vibrator?.cancel() } catch (e: Exception) { }
        vibrator = null
    }

    /** Simple tap-to-open notification (approvals, "customer allowed calls"). */
    fun info(ctx: Context, id: Int, title: String, text: String, navPath: String?, actions: List<Pair<String, PendingIntent>> = emptyList()) {
        ensureChannels(ctx)
        val open = PendingIntent.getActivity(ctx, id, Intent(ctx, MainActivity::class.java).apply {
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP)
            if (navPath != null) putExtra("nav_path", navPath)
        }, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        val b = NotificationCompat.Builder(ctx, CHANNEL_INFO)
            .setSmallIcon(R.drawable.ic_call_outgoing)
            .setContentTitle(title)
            .setContentText(text)
            .setStyle(NotificationCompat.BigTextStyle().bigText(text))
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setAutoCancel(true)
            .setContentIntent(open)
        actions.forEach { (label, pi) -> b.addAction(R.drawable.ic_launcher, label, pi) }
        (ctx.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager).notify(id, b.build())
    }
}
