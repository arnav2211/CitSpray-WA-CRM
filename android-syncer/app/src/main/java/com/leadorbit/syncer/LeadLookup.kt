package com.leadorbit.syncer

import android.content.Context
import android.util.Log
import com.google.gson.Gson
import com.google.gson.reflect.TypeToken

object LeadLookup {
    data class LeadInfo(
        val name: String,
        val id: String,
        val status: String? = null
    )

    private var phoneLeadMap: Map<String, LeadInfo> = emptyMap()

    fun loadMap(context: Context) {
        val sharedPrefs = context.getSharedPreferences("CRM_PREFS", Context.MODE_PRIVATE)
        val json = sharedPrefs.getString("phone_lead_map_json", null)
        if (!json.isNullOrEmpty()) {
            try {
                val type = object : TypeToken<Map<String, LeadInfo>>() {}.type
                phoneLeadMap = Gson().fromJson(json, type)
                Log.d("LeadLookup", "Loaded phone-lead map with ${phoneLeadMap.size} records.")
            } catch (e: Exception) {
                Log.e("LeadLookup", "Failed to parse phone-lead map: ${e.message}", e)
            }
        } else {
            phoneLeadMap = emptyMap()
        }
    }

    fun lookup(phone: String): LeadInfo? {
        val cleanPhone = phone.replace(Regex("[^0-9]"), "")
        if (cleanPhone.isEmpty()) return null
        
        // Exact match
        phoneLeadMap[cleanPhone]?.let { return it }
        
        // Matches last 10 digits
        if (cleanPhone.length >= 10) {
            val last10 = cleanPhone.takeLast(10)
            for ((k, v) in phoneLeadMap) {
                if (k.endsWith(last10)) {
                    return v
                }
            }
        }
        return null
    }
}
