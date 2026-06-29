package com.leadorbit.syncer

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import android.telecom.Call
import android.telecom.CallAudioState
import android.telecom.InCallService
import okhttp3.MediaType.Companion.toMediaTypeOrNull
import okhttp3.RequestBody.Companion.toRequestBody

class CallService : InCallService() {

    interface CallListener {
        fun onCallStarted(call: Call)
        fun onCallEnded()
    }

    companion object {
        var activeCall: Call? = null
        var activeCallService: CallService? = null
        val callsList = mutableListOf<Call>()
        var listener: CallListener? = null

        fun mute(isMuted: Boolean) {
            activeCallService?.setMuted(isMuted)
        }

        fun toggleSpeaker(useSpeaker: Boolean) {
            val route = if (useSpeaker) {
                CallAudioState.ROUTE_SPEAKER
            } else {
                CallAudioState.ROUTE_EARPIECE
            }
            activeCallService?.setAudioRoute(route)
        }

        fun hangUp() {
            activeCall?.disconnect()
        }
    }

    override fun onCallAdded(call: Call) {
        super.onCallAdded(call)
        
        callsList.add(call)
        activeCall = call
        activeCallService = this
        
        // Register call state listener
        call.registerCallback(callCallback)

        // Show foreground notification
        showNotification(call)

        // Report call started event to backend
        reportCallEvent(applicationContext, getPhoneNumber(call), "started", 0, null)
        
        // Notify active UI listener
        listener?.onCallStarted(call)

        // Launch custom In-Call UI screen
        val intent = Intent(this, CallActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP
        }
        startActivity(intent)
    }

    override fun onCallRemoved(call: Call) {
        super.onCallRemoved(call)
        call.unregisterCallback(callCallback)
        
        callsList.remove(call)
        if (activeCall == call) {
            activeCall = callsList.lastOrNull()
            if (activeCall == null) {
                activeCallService = null
                listener?.onCallEnded()
            } else {
                activeCall?.let { listener?.onCallStarted(it) }
            }
        }
        if (callsList.isEmpty()) {
            stopForeground(true)
            stopSelf()
        }
    }

    private val callCallback = object : Call.Callback() {
        override fun onStateChanged(call: Call, state: Int) {
            super.onStateChanged(call, state)
            val number = getPhoneNumber(call)
            
            if (state == Call.STATE_DISCONNECTED) {
                // Stop call recording if active
                if (CallRecorder.isRecording()) {
                    val path = CallRecorder.stopRecording()
                    if (path != null) {
                        android.os.Handler(android.os.Looper.getMainLooper()).post {
                            android.widget.Toast.makeText(applicationContext, "Recording saved: $path", android.widget.Toast.LENGTH_LONG).show()
                        }
                    }
                }

                // Call disconnected: Trigger the custom post-call notes dialog
                val duration = getCallDuration(call)
                val isOutgoing = call.details.callDirection == Call.Details.DIRECTION_OUTGOING
                
                // Get call creation time (epoch milliseconds), fall back to current time if 0
                val creationTime = call.details.creationTimeMillis
                val startTime = if (creationTime > 0L) creationTime else System.currentTimeMillis()

                val outcome = if (duration > 0) "connected" else "no_response"
                
                // Report call ended event to backend
                reportCallEvent(applicationContext, number, "ended", duration, outcome)

                if (duration > 0) {
                    val intent = Intent(applicationContext, PostCallActivity::class.java).apply {
                        flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
                        putExtra("phone_number", number)
                        putExtra("call_duration_seconds", duration)
                        putExtra("is_outgoing", isOutgoing)
                        putExtra("call_start_time", startTime)
                    }
                    startActivity(intent)
                } else {
                    android.util.Log.d("CallService", "Call was not connected (duration 0). Skipping PostCallActivity.")
                }

                callsList.remove(call)
                if (activeCall == call) {
                    activeCall = callsList.lastOrNull()
                    if (activeCall == null) {
                        activeCallService = null
                        listener?.onCallEnded()
                    } else {
                        activeCall?.let { listener?.onCallStarted(it) }
                    }
                }

                if (callsList.isEmpty()) {
                    stopForeground(true)
                    stopSelf()
                }
            } else if (state == Call.STATE_ACTIVE) {
                // Call answered: Report event to backend
                reportCallEvent(applicationContext, number, "answered", 0, null)
                // Notify UI listener to update active status
                listener?.onCallStarted(call)
            }
        }
    }

    private fun getPhoneNumber(call: Call): String {
        val uri = call.details.handle
        return uri?.schemeSpecificPart ?: ""
    }

    private fun getCallDuration(call: Call): Int {
        val connectTime = call.details.connectTimeMillis
        if (connectTime == 0L) return 0
        val durationMs = System.currentTimeMillis() - connectTime
        return (durationMs / 1000).toInt()
    }

    private fun showNotification(call: Call) {
        val number = getPhoneNumber(call)
        val notificationManager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                "active_call_channel",
                "Active Call",
                NotificationManager.IMPORTANCE_LOW
            )
            notificationManager.createNotificationChannel(channel)
        }
        
        val intent = Intent(this, CallActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP
        }
        val pendingIntent = PendingIntent.getActivity(
            this,
            0,
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        
        val notification = androidx.core.app.NotificationCompat.Builder(this, "active_call_channel")
            .setContentTitle("Active CRM Call")
            .setContentText("Call in progress with $number. Tap to return.")
            .setSmallIcon(R.drawable.ic_call_answer)
            .setContentIntent(pendingIntent)
            .setOngoing(true)
            .setCategory(androidx.core.app.NotificationCompat.CATEGORY_CALL)
            .setVisibility(androidx.core.app.NotificationCompat.VISIBILITY_PUBLIC)
            .build()
            
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(1001, notification, android.content.pm.ServiceInfo.FOREGROUND_SERVICE_TYPE_PHONE_CALL)
        } else {
            startForeground(1001, notification)
        }
    }

    private fun reportCallEvent(context: Context, phone: String, eventType: String, durationSeconds: Int, outcome: String?) {
        val sharedPrefs = context.getSharedPreferences("CRM_PREFS", Context.MODE_PRIVATE)
        val token = sharedPrefs.getString("auth_token", null) ?: return
        
        Thread {
            try {
                val client = okhttp3.OkHttpClient()
                val json = org.json.JSONObject().apply {
                    put("phone", phone)
                    put("event", eventType)
                    put("duration_seconds", durationSeconds)
                    if (outcome != null) {
                        put("outcome", outcome)
                    }
                }
                
                val body = json.toString().toRequestBody("application/json; charset=utf-8".toMediaTypeOrNull())
                
                val request = okhttp3.Request.Builder()
                    .url("https://crm.mangalamagro.in/api/calls/events")
                    .addHeader("Authorization", "Bearer $token")
                    .post(body)
                    .build()
                
                client.newCall(request).execute().use { response ->
                    if (!response.isSuccessful) {
                        android.util.Log.e("CallService", "Failed to report call event: ${response.code}")
                    }
                }
            } catch (e: Exception) {
                android.util.Log.e("CallService", "Error reporting call event: ${e.message}")
            }
        }.start()
    }
}
