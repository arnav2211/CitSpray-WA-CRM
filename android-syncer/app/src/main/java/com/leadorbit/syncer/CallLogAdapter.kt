package com.leadorbit.syncer

import android.content.Context
import android.provider.CallLog
import android.text.format.DateUtils
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.ImageButton
import android.widget.ImageView
import android.widget.TextView
import androidx.recyclerview.widget.RecyclerView
import java.util.Locale

data class CallLogItem(
    val number: String,
    val contactName: String?,
    val crmName: String?,
    val leadId: String?,
    val type: Int,
    val date: Long,
    val duration: Long
)

class CallLogAdapter(
    private val context: Context,
    private val logs: List<CallLogItem>,
    private val onAction: (phone: String, action: String) -> Unit
) : RecyclerView.Adapter<CallLogAdapter.ViewHolder>() {

    class ViewHolder(view: View) : RecyclerView.ViewHolder(view) {
        val imgCallType: ImageView = view.findViewById(R.id.imgCallType)
        val txtNames: TextView = view.findViewById(R.id.txtNames)
        val txtPhone: TextView = view.findViewById(R.id.txtPhone)
        val txtTime: TextView = view.findViewById(R.id.txtTime)
        val btnViewLead: ImageButton = view.findViewById(R.id.btnViewLead)
        val btnViewChat: ImageButton = view.findViewById(R.id.btnViewChat)
        val btnCallLogCall: ImageButton = view.findViewById(R.id.btnCallLogCall)
    }

    override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): ViewHolder {
        val view = LayoutInflater.from(parent.context).inflate(R.layout.item_call_log, parent, false)
        return ViewHolder(view)
    }

    override fun onBindViewHolder(holder: ViewHolder, position: Int) {
        val item = logs[position]
        
        // Format Names
        val hasContact = !item.contactName.isNullOrEmpty()
        val hasCrm = !item.crmName.isNullOrEmpty()
        
        holder.txtNames.text = when {
            hasContact && hasCrm && item.contactName != item.crmName -> {
                "${item.contactName} [Phone] / ${item.crmName} [CRM]"
            }
            hasCrm -> "${item.crmName} [CRM]"
            hasContact -> "${item.contactName} [Phone]"
            else -> item.number
        }
        
        holder.txtPhone.text = item.number

        // Format Date/Time
        val relativeTime = DateUtils.getRelativeTimeSpanString(
            item.date,
            System.currentTimeMillis(),
            DateUtils.MINUTE_IN_MILLIS
        )
        
        // Format Duration
        val min = item.duration / 60
        val sec = item.duration % 60
        val durationStr = if (min > 0) "${min}m ${sec}s" else "${sec}s"
        holder.txtTime.text = "$relativeTime ($durationStr)"

        // Bind Call Type Icon & Tint
        val (iconRes, tintColor) = when (item.type) {
            CallLog.Calls.INCOMING_TYPE -> Pair(R.drawable.ic_call_incoming, "#30D158") // Green
            CallLog.Calls.OUTGOING_TYPE -> Pair(R.drawable.ic_call_outgoing, "#0A84FF") // Blue
            CallLog.Calls.MISSED_TYPE -> Pair(R.drawable.ic_call_missed, "#FF453A") // Red
            CallLog.Calls.REJECTED_TYPE -> Pair(R.drawable.ic_call_missed, "#FF9F0A") // Orange
            else -> Pair(R.drawable.ic_call_incoming, "#8E8E93")
        }
        
        holder.imgCallType.setImageResource(iconRes)
        holder.imgCallType.setColorFilter(android.graphics.Color.parseColor(tintColor))

        // Actions
        holder.btnCallLogCall.setOnClickListener {
            onAction(item.number, "call")
        }
        holder.btnViewLead.setOnClickListener {
            onAction(item.number, "lead")
        }
        holder.btnViewChat.setOnClickListener {
            onAction(item.number, "whatsapp")
        }
        holder.itemView.setOnClickListener {
            onAction(item.number, "call")
        }
    }

    override fun getItemCount() = logs.size
}
