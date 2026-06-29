package com.leadorbit.syncer

import android.content.Context
import android.content.SharedPreferences
import android.os.Bundle
import android.util.Log
import android.widget.Button
import android.widget.EditText
import android.widget.TextView
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import com.google.gson.annotations.SerializedName
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
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

class PostCallActivity : AppCompatActivity() {

    private lateinit var callDetailsLabel: TextView
    private lateinit var notesInput: EditText
    private lateinit var saveSyncButton: Button
    private lateinit var sharedPrefs: SharedPreferences
    private lateinit var outcomeSpinner: android.widget.Spinner

    private var phoneNumber: String = ""
    private var durationSeconds: Int = 0
    private var isOutgoing: Boolean = true
    private var callStartTime: Long = 0L

    // Define simple Retrofit client matching SyncWorker structure
    interface CrmApiService {
        @POST("api/calls/sync-batch")
        suspend fun syncBatch(
            @Header("Authorization") token: String,
            @Body body: SyncBatchPayload
        ): SyncResponse
    }

    data class SyncBatchPayload(
        @SerializedName("logs") val logs: List<CallRecordDto>
    )

    data class CallRecordDto(
        @SerializedName("phone") val phone: String,
        @SerializedName("call_type") val callType: String,
        @SerializedName("timestamp") val timestamp: String,
        @SerializedName("duration_seconds") val durationSeconds: Int,
        @SerializedName("note") val note: String? = null,
        @SerializedName("direction") val direction: String? = null,
        @SerializedName("lead_status") val leadStatus: String? = null
    )

    data class SyncResponse(
        @SerializedName("success") val success: Boolean
    )

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_post_call)

        // Read extras
        phoneNumber = intent.getStringExtra("phone_number") ?: ""
        durationSeconds = intent.getIntExtra("call_duration_seconds", 0)
        isOutgoing = intent.getBooleanExtra("is_outgoing", true)
        callStartTime = intent.getLongExtra("call_start_time", 0L)
        if (callStartTime == 0L) {
            callStartTime = System.currentTimeMillis()
        }

        callDetailsLabel = findViewById(R.id.callDetailsLabel)
        notesInput = findViewById(R.id.notesInput)
        saveSyncButton = findViewById(R.id.saveSyncButton)
        sharedPrefs = getSharedPreferences("CRM_PREFS", Context.MODE_PRIVATE)

        // Initialize Spinner
        outcomeSpinner = findViewById(R.id.outcomeSpinner)
        val outcomesList = arrayOf(
            "Connected - Interested",
            "Connected - Follow Up",
            "Connected - Converted",
            "Connected - Lost/Not Interested",
            "No Response (PNR)",
            "Not Reachable",
            "Busy",
            "Rejected (Declined)"
        )
        val adapter = android.widget.ArrayAdapter(this, android.R.layout.simple_spinner_item, outcomesList)
        adapter.setDropDownViewResource(android.R.layout.simple_spinner_dropdown_item)
        outcomeSpinner.adapter = adapter

        // Display Details
        val min = durationSeconds / 60
        val sec = durationSeconds % 60
        val durationStr = if (min > 0) "${min}m ${sec}s" else "${sec}s"
        callDetailsLabel.text = "Phone: $phoneNumber | Duration: $durationStr"

        saveSyncButton.setOnClickListener {
            saveAndSyncCall()
        }
    }

    private fun saveAndSyncCall() {
        val token = sharedPrefs.getString("auth_token", null)
        if (token == null) {
            Toast.makeText(this, "Not logged in! Call details saved locally only.", Toast.LENGTH_LONG).show()
            finish()
            return
        }

        val selectedIndex = outcomeSpinner.selectedItemPosition
        val (outcome, leadStatus) = when (selectedIndex) {
            0 -> Pair("connected", "qualified")      // Connected - Interested
            1 -> Pair("connected", "contacted")      // Connected - Follow Up
            2 -> Pair("connected", "converted")      // Connected - Converted
            3 -> Pair("connected", "lost")           // Connected - Lost/Not Interested
            4 -> Pair("no_response", "contacted")    // No Response (PNR)
            5 -> Pair("not_reachable", "contacted") // Not Reachable
            6 -> Pair("busy", "contacted")          // Busy
            7 -> Pair("rejected", "contacted")      // Rejected (Declined)
            else -> Pair("connected", "contacted")
        }

        val note = notesInput.text.toString().trim()
        val timestampIso = formatEpochToIso8601(callStartTime)

        saveSyncButton.isEnabled = false
        saveSyncButton.text = "Syncing with CRM..."

        // Launch in CoroutineScope
        CoroutineScope(Dispatchers.IO).launch {
            try {
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

                // Sync payload
                val payload = SyncBatchPayload(
                    logs = listOf(
                        CallRecordDto(
                            phone = phoneNumber,
                            callType = outcome,
                            timestamp = timestampIso,
                            durationSeconds = durationSeconds,
                            note = note,
                            direction = if (isOutgoing) "outgoing" else "incoming",
                            leadStatus = leadStatus
                        )
                    )
                )

                val bearerToken = "Bearer $token"
                val response = apiService.syncBatch(bearerToken, payload)

                withContext(Dispatchers.Main) {
                    if (response.success) {
                        Toast.makeText(applicationContext, "Call log synced successfully!", Toast.LENGTH_SHORT).show()
                    } else {
                        Toast.makeText(applicationContext, "CRM rejected call log sync.", Toast.LENGTH_LONG).show()
                    }
                    finish()
                }

            } catch (e: Exception) {
                Log.e("PostCallActivity", "Sync failed: ${e.message}", e)
                withContext(Dispatchers.Main) {
                    Toast.makeText(applicationContext, "Network failed: Call saved locally.", Toast.LENGTH_LONG).show()
                    finish()
                }
            }
        }
    }

    private fun formatEpochToIso8601(epoch: Long): String {
        val sdf = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US)
        sdf.timeZone = TimeZone.getTimeZone("UTC")
        return sdf.format(Date(epoch))
    }
}
