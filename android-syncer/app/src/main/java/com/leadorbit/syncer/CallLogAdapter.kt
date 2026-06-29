package com.leadorbit.syncer

import android.content.Context
import android.provider.CallLog
import android.text.format.DateUtils
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.Button
import android.widget.ImageButton
import android.widget.ImageView
import android.widget.TextView
import androidx.recyclerview.widget.RecyclerView

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
        val btnViewLead: Button = view.findViewById(R.id.btnViewLead)
        val btnViewChat: Button = view.findViewById(R.id.btnViewChat)
        val btnCallLogCall: Button = view.findViewById(R.id.btnCallLogCall)
        val btnExpand: ImageButton = view.findViewById(R.id.btnExpand)
        val layoutExpandedDetails: View = view.findViewById(R.id.layoutExpandedDetails)
        val txtExecutive: TextView = view.findViewById(R.id.txtExecutive)
        val txtDuration: TextView = view.findViewById(R.id.txtDuration)
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
                "${item.contactName} / ${item.crmName}"
            }
            hasCrm -> item.crmName
            hasContact -> item.contactName
            else -> item.number
        }
        
        holder.txtPhone.text = item.number

        // Format Date/Time
        val relativeTime = DateUtils.getRelativeTimeSpanString(
            item.date,
            System.currentTimeMillis(),
            DateUtils.MINUTE_IN_MILLIS
        )
        holder.txtTime.text = relativeTime

        // Format Duration
        val min = item.duration / 60
        val sec = item.duration % 60
        val durationStr = if (min > 0) "${min}m ${sec}s" else "${sec}s"
        holder.txtDuration.text = durationStr

        // Executive Name from SharedPreferences
        val sharedPrefs = context.getSharedPreferences("CRM_PREFS", Context.MODE_PRIVATE)
        val execName = sharedPrefs.getString("user_name", null) ?: "Executive"
        holder.txtExecutive.text = execName

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

        // Expand/Collapse Details Logic
        holder.layoutExpandedDetails.visibility = View.GONE
        holder.btnExpand.setImageResource(R.drawable.ic_chevron_down)
        
        val toggleExpand = View.OnClickListener {
            if (holder.layoutExpandedDetails.visibility == View.VISIBLE) {
                holder.layoutExpandedDetails.visibility = View.GONE
                holder.btnExpand.setImageResource(R.drawable.ic_chevron_down)
            } else {
                holder.layoutExpandedDetails.visibility = View.VISIBLE
                holder.btnExpand.setImageResource(R.drawable.ic_chevron_up)
            }
        }
        
        holder.btnExpand.setOnClickListener(toggleExpand)
        holder.itemView.setOnClickListener(toggleExpand)

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
    }

    override fun getItemCount() = logs.size
}
