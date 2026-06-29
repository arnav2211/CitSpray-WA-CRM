package com.leadorbit.syncer

import android.Manifest
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.telecom.PhoneAccountHandle
import android.telecom.TelecomManager
import androidx.appcompat.app.AlertDialog
import androidx.core.content.ContextCompat
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.MediaType.Companion.toMediaTypeOrNull
import org.json.JSONObject

object CallHelper {

    fun placeCall(context: Context, phoneNumber: String, onCallPlaced: (() -> Unit)? = null) {
        val cleanNumber = phoneNumber.replace(Regex("[^0-9+]"), "")
        if (cleanNumber.isEmpty()) return

        val telecomManager = context.getSystemService(Context.TELECOM_SERVICE) as? TelecomManager
        if (telecomManager == null) {
            placeCallDirectly(context, cleanNumber, null, onCallPlaced)
            return
        }

        // Check for READ_PHONE_STATE permission
        val hasPhoneStatePermission = ContextCompat.checkSelfPermission(
            context,
            Manifest.permission.READ_PHONE_STATE
        ) == PackageManager.PERMISSION_GRANTED

        if (!hasPhoneStatePermission) {
            // No permission to get SIM list, place call directly
            placeCallDirectly(context, cleanNumber, null, onCallPlaced)
            return
        }

        try {
            val accounts = telecomManager.getCallCapablePhoneAccounts()
            if (accounts != null && accounts.size > 1) {
                // Multi-SIM device: show selection dialog
                val items = Array(accounts.size) { index ->
                    val handle = accounts[index]
                    val account = telecomManager.getPhoneAccount(handle)
                    account?.label?.toString() ?: "SIM ${index + 1}"
                }

                AlertDialog.Builder(context)
                    .setTitle("Select SIM for Call")
                    .setItems(items) { _, which ->
                        val selectedHandle = accounts[which]
                        placeCallDirectly(context, cleanNumber, selectedHandle, onCallPlaced)
                    }
                    .setNegativeButton("Cancel", null)
                    .show()
            } else if (accounts != null && accounts.size == 1) {
                // Single active SIM: place call using that account handle explicitly
                placeCallDirectly(context, cleanNumber, accounts[0], onCallPlaced)
            } else {
                // No accounts or empty list: place call directly
                placeCallDirectly(context, cleanNumber, null, onCallPlaced)
            }
        } catch (e: SecurityException) {
            android.util.Log.e("CallHelper", "SecurityException checking phone accounts", e)
            placeCallDirectly(context, cleanNumber, null, onCallPlaced)
        } catch (e: Exception) {
            android.util.Log.e("CallHelper", "Error checking phone accounts", e)
            placeCallDirectly(context, cleanNumber, null, onCallPlaced)
        }
    }

    private fun placeCallDirectly(context: Context, cleanNumber: String, handle: PhoneAccountHandle?, onCallPlaced: (() -> Unit)? = null) {
        val uri = Uri.parse("tel:$cleanNumber")
        val intent = Intent(Intent.ACTION_CALL, uri)
        if (handle != null) {
            intent.putExtra(TelecomManager.EXTRA_PHONE_ACCOUNT_HANDLE, handle)
        }
        
        // Log initiated call event simultaneously to the backend
        logCallInitiated(context, cleanNumber)

        try {
            context.startActivity(intent)
            onCallPlaced?.invoke()
        } catch (e: SecurityException) {
            android.util.Log.e("CallHelper", "CALL_PHONE permission not granted", e)
        } catch (e: Exception) {
            android.util.Log.e("CallHelper", "Failed to place call", e)
        }
    }

    private fun logCallInitiated(context: Context, cleanNumber: String) {
        val sharedPrefs = context.getSharedPreferences("CRM_PREFS", Context.MODE_PRIVATE)
        val token = sharedPrefs.getString("auth_token", null) ?: return
        
        LeadLookup.loadMap(context)
        val lead = LeadLookup.lookup(cleanNumber) ?: return
        val leadId = lead.id

        Thread {
            try {
                val client = OkHttpClient()
                val json = JSONObject().apply {
                    put("phone", cleanNumber)
                    put("outcome", "initiated")
                    put("summary", "Outbound call initiated from LeadOrbit Android app.")
                }
                
                val body = json.toString().toRequestBody("application/json; charset=utf-8".toMediaTypeOrNull())
                
                val request = Request.Builder()
                    .url("https://crm.mangalamagro.in/api/leads/$leadId/calls")
                    .addHeader("Authorization", "Bearer $token")
                    .post(body)
                    .build()
                
                client.newCall(request).execute().use { response ->
                    if (response.isSuccessful) {
                        android.util.Log.d("CallHelper", "Successfully logged call initiation for lead $leadId")
                    } else {
                        android.util.Log.w("CallHelper", "Failed to log call initiation: ${response.code} ${response.message}")
                    }
                }
            } catch (e: Exception) {
                android.util.Log.e("CallHelper", "Error logging call initiation: ${e.message}")
            }
        }.start()
    }
}
