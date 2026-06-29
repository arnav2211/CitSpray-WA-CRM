package com.leadorbit.syncer

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.telephony.TelephonyManager
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
