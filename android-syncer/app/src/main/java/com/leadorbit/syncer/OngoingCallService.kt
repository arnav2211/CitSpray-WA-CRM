package com.leadorbit.syncer

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.util.Log
import androidx.core.app.NotificationCompat

/**
 * Runs while a WhatsApp call is in progress: keeps the microphone working when the
 * user leaves the app (Android silences background mics otherwise) and shows a
 * "call in progress" notification with Hang up.
 */
class OngoingCallService : Service() {
    companion object {
        const val ACTION_START = "com.leadorbit.syncer.CALL_START"
        const val ACTION_STOP = "com.leadorbit.syncer.CALL_STOP"
        const val ACTION_HANGUP = "com.leadorbit.syncer.CALL_HANGUP"
        const val HANGUP_BROADCAST = "com.leadorbit.syncer.WA_CALL_HANGUP"
        private const val CHANNEL = "leadorbit_wa_ongoing_channel"
        private const val NOTIF_ID = 4242

        fun start(ctx: Context, name: String) {
            val i = Intent(ctx, OngoingCallService::class.java).setAction(ACTION_START).putExtra("name", name)
            try {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) ctx.startForegroundService(i) else ctx.startService(i)
            } catch (e: Exception) {
                Log.e("OngoingCallService", "start failed", e)
            }
        }

        fun stop(ctx: Context) {
            try { ctx.stopService(Intent(ctx, OngoingCallService::class.java)) } catch (e: Exception) { }
        }
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_HANGUP -> {
                sendBroadcast(Intent(HANGUP_BROADCAST).setPackage(packageName))
                stopSelf()
                return START_NOT_STICKY
            }
            ACTION_STOP -> {
                stopSelf()
                return START_NOT_STICKY
            }
        }
        val name = intent?.getStringExtra("name").orEmpty().ifEmpty { "customer" }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            (getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager).createNotificationChannel(
                NotificationChannel(CHANNEL, "WhatsApp call in progress", NotificationManager.IMPORTANCE_LOW))
        }
        val open = PendingIntent.getActivity(this, 1, Intent(this, MainActivity::class.java).apply {
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_REORDER_TO_FRONT)
        }, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        val hang = PendingIntent.getService(this, 2, Intent(this, OngoingCallService::class.java).setAction(ACTION_HANGUP),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        val n = NotificationCompat.Builder(this, CHANNEL)
            .setSmallIcon(R.drawable.ic_call_answer)
            .setContentTitle("WhatsApp call · $name")
            .setContentText("Tap to return to the call")
            .setOngoing(true)
            .setUsesChronometer(true)
            .setWhen(System.currentTimeMillis())
            .setCategory(NotificationCompat.CATEGORY_CALL)
            .setContentIntent(open)
            .addAction(R.drawable.ic_call_end, "Hang up", hang)
            .build()
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                startForeground(NOTIF_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE)
            } else {
                startForeground(NOTIF_ID, n)
            }
        } catch (e: Exception) {
            Log.e("OngoingCallService", "startForeground failed", e)
            stopSelf()
        }
        return START_NOT_STICKY
    }
}
