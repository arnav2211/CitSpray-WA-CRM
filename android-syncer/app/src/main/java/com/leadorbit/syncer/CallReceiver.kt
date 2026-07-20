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
            return
        }

        // Handle call state change trigger
        if (TelephonyManager.ACTION_PHONE_STATE_CHANGED == action) {
            val state = intent.getStringExtra(TelephonyManager.EXTRA_STATE)

            // IDLE state occurs when a call gets disconnected (incoming or outgoing)
            if (TelephonyManager.EXTRA_STATE_IDLE == state) {
                // Trigger a fast, one-time sync task immediately
                triggerImmediateSync(context)
                // The system dialer handled the call UI — offer a "log outcome"
                // notification for connected lead calls (replaces the popup the
                // removed InCallService used to launch).
                offerPostCallLogging(context)
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

    private fun offerPostCallLogging(context: Context) {
        if (ContextCompat.checkSelfPermission(context, Manifest.permission.READ_CALL_LOG)
            != PackageManager.PERMISSION_GRANTED
        ) return

        val appContext = context.applicationContext
        val pending = goAsync()
        // Small delay: the system needs a moment to write the entry into CallLog
        Handler(Looper.getMainLooper()).postDelayed({
            try {
                notifyIfLeadCall(appContext)
            } catch (e: Exception) {
                android.util.Log.e("CallReceiver", "post-call notify failed: ${e.message}")
            } finally {
                pending.finish()
            }
        }, 2000)
    }

    private fun notifyIfLeadCall(context: Context) {
        val cursor = context.contentResolver.query(
            CallLog.Calls.CONTENT_URI,
            arrayOf(CallLog.Calls.NUMBER, CallLog.Calls.TYPE, CallLog.Calls.DURATION, CallLog.Calls.DATE),
            null, null,
            CallLog.Calls.DATE + " DESC"
        ) ?: return

        var number: String? = null
        var type = 0
        var duration = 0
        var date = 0L
        cursor.use {
            if (it.moveToFirst()) {
                number = it.getString(0)
                type = it.getInt(1)
                duration = it.getInt(2)
                date = it.getLong(3)
            }
        }
        val num = number ?: return
        // Only calls that just ended (within 90s) and actually connected
        if (System.currentTimeMillis() - (date + duration * 1000L) > 90_000L) return
        if (duration <= 0) return
        // Only prompt for numbers that belong to a CRM lead
        LeadLookup.loadMap(context)
        val lead = LeadLookup.lookup(num.replace(Regex("[^0-9+]"), "")) ?: return

        val isOutgoing = type == CallLog.Calls.OUTGOING_TYPE

        val nm = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            nm.createNotificationChannel(
                NotificationChannel(
                    "post_call", "Call outcome logging",
                    NotificationManager.IMPORTANCE_HIGH
                ).apply { description = "Prompts to log the outcome of lead calls" }
            )
        }

        val open = Intent(context, PostCallActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
            putExtra("phone_number", num)
            putExtra("call_duration_seconds", duration)
            putExtra("is_outgoing", isOutgoing)
            putExtra("call_start_time", date)
        }
        val pi = PendingIntent.getActivity(
            context, num.hashCode(), open,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        val mins = duration / 60
        val secs = duration % 60
        val notification = androidx.core.app.NotificationCompat.Builder(context, "post_call")
            .setSmallIcon(R.drawable.ic_launcher)
            .setContentTitle("Log call with ${lead.name}")
            .setContentText("${if (isOutgoing) "Outgoing" else "Incoming"} call · ${mins}m ${secs}s — tap to add outcome & notes")
            .setPriority(androidx.core.app.NotificationCompat.PRIORITY_HIGH)
            .setAutoCancel(true)
            .setContentIntent(pi)
            .build()
        nm.notify(num.hashCode(), notification)
    }
}
