package com.leadorbit.syncer

import android.content.Context
import android.content.SharedPreferences
import android.database.Cursor
import android.provider.CallLog
import android.util.Log
import androidx.work.CoroutineWorker
import androidx.work.WorkerParameters
import com.google.gson.annotations.SerializedName
import okhttp3.OkHttpClient
import okhttp3.logging.HttpLoggingInterceptor
import retrofit2.Retrofit
import retrofit2.converter.gson.GsonConverterFactory
import retrofit2.http.Body
import retrofit2.http.Header
import retrofit2.http.POST
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone

class SyncWorker(
    context: Context,
    workerParams: WorkerParameters
) : CoroutineWorker(context, workerParams) {

    private val sharedPrefs: SharedPreferences =
        context.getSharedPreferences("CRM_PREFS", Context.MODE_PRIVATE)

    // Retrofit API Definition
    interface CrmApiService {
        @POST("api/calls/sync-batch")
        suspend fun syncBatch(
            @Header("Authorization") token: String,
            @Body body: SyncBatchPayload
        ): SyncResponse
    }

    // Data Transfer Objects
    data class SyncBatchPayload(
        @SerializedName("logs") val logs: List<CallRecordDto>
    )

    data class CallRecordDto(
        @SerializedName("phone") val phone: String,
        @SerializedName("call_type") val callType: String,
        @SerializedName("timestamp") val timestamp: String,
        @SerializedName("duration_seconds") val durationSeconds: Int,
        @SerializedName("note") val note: String? = null,
        @SerializedName("direction") val direction: String? = null
    )

    data class SyncResponse(
        @SerializedName("success") val success: Boolean,
        @SerializedName("synced") val synced: Int,
        @SerializedName("matched") val matched: Int,
        @SerializedName("reassigned") val reassigned: Int
    )

    override suspend fun doWork(): Result {
        val token = sharedPrefs.getString("auth_token", null)
        if (token == null) {
            Log.d("SyncWorker", "Abort: User not logged in, no token found.")
            return Result.success()
        }

        // Ensure NotificationSyncService is running
        try {
            val serviceIntent = android.content.Intent(applicationContext, NotificationSyncService::class.java).apply {
                action = NotificationSyncService.ACTION_START
            }
            if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.O) {
                applicationContext.startForegroundService(serviceIntent)
            } else {
                applicationContext.startService(serviceIntent)
            }
        } catch (e: Exception) {
            Log.e("SyncWorker", "Failed to start service from background worker: ${e.message}")
        }

        var lastSyncTime = sharedPrefs.getLong("last_synced_timestamp", 0L)
        if (lastSyncTime == 0L) {
            // First run: set watermark to current time so only calls made after app installation are synced
            lastSyncTime = System.currentTimeMillis()
            sharedPrefs.edit().putLong("last_synced_timestamp", lastSyncTime).apply()
            Log.d("SyncWorker", "First run: initialized watermark to current time.")
        }

        val unsyncedLogs = fetchCallLogsSince(lastSyncTime)
        
        if (unsyncedLogs.isEmpty()) {
            Log.d("SyncWorker", "No new calls to sync.")
            return Result.success()
        }

        Log.d("SyncWorker", "Found ${unsyncedLogs.size} unsynced calls. Syncing...")

        try {
            // Setup Retrofit
            val logging = HttpLoggingInterceptor().apply {
                level = HttpLoggingInterceptor.Level.BODY
            }
            val client = OkHttpClient.Builder()
                .addInterceptor(logging)
                .build()

            val retrofit = Retrofit.Builder()
                .baseUrl("https://crm.mangalamagro.in/")
                .client(client)
                .addConverterFactory(GsonConverterFactory.create())
                .build()

            val apiService = retrofit.create(CrmApiService::class.java)

            // Prepare Payload
            val payload = SyncBatchPayload(logs = unsyncedLogs.map { log ->
                CallRecordDto(
                    phone = log.phone,
                    callType = log.callType,
                    timestamp = formatEpochToIso8601(log.timestamp),
                    durationSeconds = log.duration,
                    direction = if (log.callType == "incoming" || log.callType == "missed") "incoming" else "outgoing"
                )
            })

            // Sync
            val bearerToken = "Bearer $token"
            val response = apiService.syncBatch(bearerToken, payload)

            if (response.success) {
                // Update local synced benchmark to the newest timestamp in this batch
                val maxTimestamp = unsyncedLogs.maxOf { it.timestamp }
                sharedPrefs.edit().putLong("last_synced_timestamp", maxTimestamp).apply()
                Log.d("SyncWorker", "Batch synced successfully: ${response.synced} items.")
                return Result.success()
            } else {
                Log.w("SyncWorker", "Server rejected sync batch.")
                return Result.retry()
            }

        } catch (e: Exception) {
            Log.e("SyncWorker", "Sync request failed: ${e.message}", e)
            return Result.retry()
        }
    }

    // Call log data class for local query representation
    private data class CallLogEntry(
        val phone: String,
        val callType: String,
        val timestamp: Long,
        val duration: Int
    )

    private fun fetchCallLogsSince(sinceTime: Long): List<CallLogEntry> {
        val list = mutableListOf<CallLogEntry>()
        val contentResolver = applicationContext.contentResolver
        
        val projection = arrayOf(
            CallLog.Calls.NUMBER,
            CallLog.Calls.TYPE,
            CallLog.Calls.DATE,
            CallLog.Calls.DURATION
        )
        
        // Select logs newer than sinceTime, sorted newest first
        val selection = "${CallLog.Calls.DATE} > ?"
        val selectionArgs = arrayOf(sinceTime.toString())
        val sortOrder = "${CallLog.Calls.DATE} DESC"

        var cursor: Cursor? = null
        try {
            cursor = contentResolver.query(
                CallLog.Calls.CONTENT_URI,
                projection,
                selection,
                selectionArgs,
                sortOrder
            )

            if (cursor != null && cursor.moveToFirst()) {
                val numberIdx = cursor.getColumnIndex(CallLog.Calls.NUMBER)
                val typeIdx = cursor.getColumnIndex(CallLog.Calls.TYPE)
                val dateIdx = cursor.getColumnIndex(CallLog.Calls.DATE)
                val durationIdx = cursor.getColumnIndex(CallLog.Calls.DURATION)

                do {
                    val phone = cursor.getString(numberIdx) ?: ""
                    val typeRaw = cursor.getInt(typeIdx)
                    val timestamp = cursor.getLong(dateIdx)
                    val duration = cursor.getInt(durationIdx)

                    if (phone.isNotEmpty()) {
                        val callType = mapCallType(typeRaw)
                        list.add(CallLogEntry(phone, callType, timestamp, duration))
                    }
                } while (cursor.moveToNext())
            }
        } catch (e: SecurityException) {
            Log.e("SyncWorker", "Permission denied when reading call logs", e)
        } finally {
            cursor?.close()
        }

        return list
    }

    private fun mapCallType(type: Int): String {
        return when (type) {
            CallLog.Calls.OUTGOING_TYPE -> "outgoing"
            CallLog.Calls.INCOMING_TYPE -> "incoming"
            CallLog.Calls.MISSED_TYPE -> "missed"
            CallLog.Calls.REJECTED_TYPE -> "rejected"
            CallLog.Calls.BLOCKED_TYPE -> "blocked"
            else -> "unknown"
        }
    }

    private fun formatEpochToIso8601(epoch: Long): String {
        val sdf = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US)
        sdf.timeZone = TimeZone.getTimeZone("UTC")
        return sdf.format(Date(epoch))
    }
}
