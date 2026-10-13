package com.leadorbit.syncer

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.provider.CallLog
import android.telephony.TelephonyManager
import androidx.core.content.ContextCompat
import androidx.work.Constraints
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkManager

class CallReceiver : BroadcastReceiver() {

    override fun onReceive(context: Context, intent: Intent) {
        val action = intent.action

        // Handle boot completed to ensure the periodic sync configuration remains loaded
        if (Intent.ACTION_BOOT_COMPLETED == action) {
            triggerImmediateSync(context)
            // reconnect for WhatsApp calls / alerts right after the phone restarts
            if (context.getSharedPreferences("CRM_PREFS", Context.MODE_PRIVATE).getString("auth_token", null) != null) {
                try {
                    val svc = Intent(context, NotificationSyncService::class.java).setAction(NotificationSyncService.ACTION_START)
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) context.startForegroundService(svc) else context.startService(svc)
                } catch (e: Exception) { }
            }
            return
        }

        // Handle call state change trigger
        if (TelephonyManager.ACTION_PHONE_STATE_CHANGED == action) {
            val state = intent.getStringExtra(TelephonyManager.EXTRA_STATE)

            // IDLE state occurs when a call gets disconnected (incoming or outgoing)
            if (TelephonyManager.EXTRA_STATE_IDLE == state) {
                // Trigger a fast, one-time sync task immediately
                triggerImmediateSync(context)
                // ...and upload the phone's recording of it for an AI summary
                RecordingSyncWorker.enqueueSoon(context)
                // (No manual "log call" prompt any more: the AI call summary fills it in.)
            }
        }
    }

    private fun triggerImmediateSync(context: Context) {
        val constraints = Constraints.Builder()
            .setRequiredNetworkType(NetworkType.CONNECTED)
            .build()

        val oneTimeWorkRequest = OneTimeWorkRequestBuilder<SyncWorker>()
            .setConstraints(constraints)
            .build()

        // Enqueue unique work with REPLACE policy so multiple rapid calls merge into one execution
        WorkManager.getInstance(context.applicationContext).enqueueUniqueWork(
            "CallSyncImmediate",
            ExistingWorkPolicy.REPLACE,
            oneTimeWorkRequest
        )
    }
}
