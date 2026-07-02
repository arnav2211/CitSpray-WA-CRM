package com.leadorbit.syncer

import android.Manifest
import android.content.Context
import android.content.Intent
import android.content.SharedPreferences
import android.content.pm.PackageManager
import android.database.Cursor
import android.net.Uri
import android.os.Bundle
import android.provider.CallLog
import android.provider.ContactsContract
import android.util.Log
import android.widget.Button
import android.widget.EditText
import android.widget.ImageButton
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import androidx.recyclerview.widget.LinearLayoutManager
import androidx.recyclerview.widget.RecyclerView
import com.google.gson.Gson
import com.google.gson.annotations.SerializedName
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody

class DialpadActivity : AppCompatActivity() {

    private lateinit var dialInput: EditText
    private lateinit var callLogRecyclerView: RecyclerView
    private lateinit var sharedPrefs: SharedPreferences
    private val client = OkHttpClient()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_dialpad)

        dialInput = findViewById(R.id.dialInput)
        // The on-screen dialpad is the input method; keep the soft keyboard away
        dialInput.showSoftInputOnFocus = false
        callLogRecyclerView = findViewById(R.id.callLogRecyclerView)
        sharedPrefs = getSharedPreferences("CRM_PREFS", Context.MODE_PRIVATE)

        callLogRecyclerView.layoutManager = LinearLayoutManager(this)

        // Initialize lead lookup cache
        LeadLookup.loadMap(this)

        // Load call logs
        loadCallLogs()

        // Dialpad digit buttons
        val digitButtons = mapOf(
            R.id.btn0 to "0", R.id.btn1 to "1", R.id.btn2 to "2",
            R.id.btn3 to "3", R.id.btn4 to "4", R.id.btn5 to "5",
            R.id.btn6 to "6", R.id.btn7 to "7", R.id.btn8 to "8",
            R.id.btn9 to "9", R.id.btnStar to "*", R.id.btnHash to "#"
        )

        for ((id, digit) in digitButtons) {
            findViewById<Button>(id).setOnClickListener {
                dialInput.append(digit)
            }
        }

        // Backspace
        findViewById<ImageButton>(R.id.backspaceButton).setOnClickListener {
            val text = dialInput.text
            if (text.isNotEmpty()) {
                dialInput.text.delete(text.length - 1, text.length)
            }
        }

        // Long press backspace to clear all
        findViewById<ImageButton>(R.id.backspaceButton).setOnLongClickListener {
            dialInput.text.clear()
            true
        }

        // Call button
        findViewById<ImageButton>(R.id.dialCallButton).setOnClickListener {
            val number = dialInput.text.toString().trim()
            if (number.isNotEmpty()) {
                CallHelper.placeCall(this, number) {
                    finish()
                }
            }
        }
    }

    private fun loadCallLogs() {
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.READ_CALL_LOG) != PackageManager.PERMISSION_GRANTED) {
            Toast.makeText(this, "Call Log permission required to display logs", Toast.LENGTH_SHORT).show()
            return
        }

        CoroutineScope(Dispatchers.IO).launch {
            val list = mutableListOf<CallLogItem>()
            val contentResolver = contentResolver
            val projection = arrayOf(
                CallLog.Calls.NUMBER,
                CallLog.Calls.CACHED_NAME,
                CallLog.Calls.TYPE,
                CallLog.Calls.DATE,
                CallLog.Calls.DURATION
            )
            
            var cursor: Cursor? = null
            try {
                cursor = contentResolver.query(
                    CallLog.Calls.CONTENT_URI,
                    projection,
                    null, null,
                    "${CallLog.Calls.DATE} DESC LIMIT 50"
                )

                if (cursor != null && cursor.moveToFirst()) {
                    val numberIdx = cursor.getColumnIndex(CallLog.Calls.NUMBER)
                    val cachedNameIdx = cursor.getColumnIndex(CallLog.Calls.CACHED_NAME)
                    val typeIdx = cursor.getColumnIndex(CallLog.Calls.TYPE)
                    val dateIdx = cursor.getColumnIndex(CallLog.Calls.DATE)
                    val durationIdx = cursor.getColumnIndex(CallLog.Calls.DURATION)

                    do {
                        val number = cursor.getString(numberIdx) ?: ""
                        if (number.isEmpty()) continue

                        // 1. Get contact name from native cache, or fallback to Contacts Provider query
                        var contactName = cursor.getString(cachedNameIdx)
                        if (contactName.isNullOrEmpty()) {
                            contactName = getContactNameFromProvider(number)
                        }

                        // 2. Get CRM Lead info from memory lookup
                        val crmLead = LeadLookup.lookup(number)
                        
                        list.add(
                            CallLogItem(
                                number = number,
                                contactName = contactName,
                                crmName = crmLead?.name,
                                leadId = crmLead?.id,
                                type = cursor.getInt(typeIdx),
                                date = cursor.getLong(dateIdx),
                                duration = cursor.getLong(durationIdx)
                            )
                        )
                    } while (cursor.moveToNext())
                }
            } catch (e: Exception) {
                Log.e("DialpadActivity", "Failed to query call logs: ${e.message}")
            } finally {
                cursor?.close()
            }

            withContext(Dispatchers.Main) {
                callLogRecyclerView.adapter = CallLogAdapter(this@DialpadActivity, list) { phone, action ->
                    handleCallLogAction(phone, action)
                }
            }
        }
    }

    private fun getContactNameFromProvider(phoneNumber: String): String? {
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.READ_CONTACTS) != PackageManager.PERMISSION_GRANTED) {
            return null
        }
        try {
            val uri = Uri.withAppendedPath(ContactsContract.PhoneLookup.CONTENT_FILTER_URI, Uri.encode(phoneNumber))
            val cursor = contentResolver.query(uri, arrayOf(ContactsContract.PhoneLookup.DISPLAY_NAME), null, null, null)
            cursor?.use {
                if (it.moveToFirst()) {
                    return it.getString(0)
                }
            }
        } catch (e: Exception) {
            Log.e("DialpadActivity", "Failed to query ContactsContract: ${e.message}")
        }
        return null
    }

    private fun handleCallLogAction(phone: String, action: String) {
        if (action == "call") {
            CallHelper.placeCall(this, phone) {
                finish()
            }
        } else {
            // "lead" or "whatsapp": deep link to web app
            val token = sharedPrefs.getString("auth_token", null)
            if (token == null) {
                Toast.makeText(this, "Please log in to use CRM deep links.", Toast.LENGTH_SHORT).show()
                return
            }

            Toast.makeText(this, "Loading CRM details...", Toast.LENGTH_SHORT).show()
            
            CoroutineScope(Dispatchers.IO).launch {
                try {
                    val mediaType = "application/json; charset=utf-8".toMediaType()
                    val requestBody = Gson().toJson(mapOf("phone" to phone)).toRequestBody(mediaType)
                    
                    val request = Request.Builder()
                        .url("https://crm.mangalamagro.in/api/leads/get-or-create")
                        .post(requestBody)
                        .addHeader("Authorization", "Bearer $token")
                        .build()
                        
                    client.newCall(request).execute().use { response ->
                        if (response.isSuccessful) {
                            val body = response.body?.string() ?: ""
                            val resObj = Gson().fromJson(body, GetOrCreateResponse::class.java)
                            val leadId = resObj.leadId
                            
                            if (!leadId.isNullOrEmpty()) {
                                val navPath = if (action == "lead") {
                                    "/leads/$leadId"
                                } else {
                                    "/chat?lead=$leadId"
                                }
                                
                                withContext(Dispatchers.Main) {
                                    val intent = Intent(this@DialpadActivity, MainActivity::class.java).apply {
                                        flags = Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP
                                        putExtra("nav_path", navPath)
                                    }
                                    startActivity(intent)
                                    finish()
                                }
                            }
                        } else {
                            withContext(Dispatchers.Main) {
                                Toast.makeText(this@DialpadActivity, "Failed to get lead details from CRM.", Toast.LENGTH_SHORT).show()
                            }
                        }
                    }
                } catch (e: Exception) {
                    Log.e("DialpadActivity", "Failed to navigate to lead: ${e.message}")
                    withContext(Dispatchers.Main) {
                        Toast.makeText(this@DialpadActivity, "Network error. Please try again.", Toast.LENGTH_SHORT).show()
                    }
                }
            }
        }
    }

    private data class GetOrCreateResponse(
        @SerializedName("lead_id") val leadId: String?
    )
}
