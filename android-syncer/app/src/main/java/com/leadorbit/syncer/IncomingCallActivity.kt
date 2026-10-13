package com.leadorbit.syncer

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.os.Build
import android.os.Bundle
import android.view.Gravity
import android.view.WindowManager
import android.widget.ImageButton
import android.widget.LinearLayout
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat

/** Full-screen "incoming WhatsApp call" screen - over the lock screen and other apps. */
class IncomingCallActivity : AppCompatActivity() {

    companion object {
        fun intent(ctx: Context, callId: String, name: String, phone: String, company: String): Intent =
            Intent(ctx, IncomingCallActivity::class.java).apply {
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
                putExtra("call_id", callId)
                putExtra("name", name)
                putExtra("phone", phone)
                putExtra("company", company)
            }
    }

    private var callId: String = ""
    private val clearReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) {
            if (intent.getStringExtra("call_id") == callId) finish()
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
            setShowWhenLocked(true)
            setTurnScreenOn(true)
        } else {
            @Suppress("DEPRECATION")
            window.addFlags(WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED or WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON)
        }
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        ContextCompat.registerReceiver(this, clearReceiver, IntentFilter(WaCallNotifier.ACTION_CLEAR_BROADCAST),
            ContextCompat.RECEIVER_NOT_EXPORTED)
        render(intent)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        render(intent)
    }

    private fun dp(v: Int) = (v * resources.displayMetrics.density).toInt()

    private fun render(i: Intent) {
        callId = i.getStringExtra("call_id") ?: ""
        if (callId.isEmpty() || !WaCallNotifier.isRinging(callId)) {
            finish()
            return
        }
        val name = i.getStringExtra("name") ?: "WhatsApp caller"
        val phone = i.getStringExtra("phone") ?: ""
        val company = i.getStringExtra("company") ?: ""

        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER_HORIZONTAL
            setPadding(dp(24), dp(72), dp(24), dp(56))
            background = GradientDrawable(GradientDrawable.Orientation.TOP_BOTTOM, intArrayOf(Color.parseColor("#075E54"), Color.parseColor("#04332D")))
        }
        fun text(t: String, size: Float, bold: Boolean = false, color: String = "#FFFFFF", top: Int = 0) =
            TextView(this).apply {
                text = t; textSize = size; setTextColor(Color.parseColor(color)); gravity = Gravity.CENTER
                if (bold) typeface = Typeface.DEFAULT_BOLD
                layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply { topMargin = dp(top) }
            }
        root.addView(text("WHATSAPP CALL · ${company.uppercase()}", 12f, color = "#A7F3D0"))
        val initial = name.firstOrNull { it.isLetterOrDigit() }?.uppercaseChar()?.toString() ?: "W"
        root.addView(TextView(this).apply {
            text = initial; textSize = 40f; setTextColor(Color.WHITE); gravity = Gravity.CENTER; typeface = Typeface.DEFAULT_BOLD
            background = GradientDrawable().apply { shape = GradientDrawable.OVAL; setColor(Color.parseColor("#33FFFFFF")) }
            layoutParams = LinearLayout.LayoutParams(dp(110), dp(110)).apply { topMargin = dp(32) }
        })
        root.addView(text(name, 28f, bold = true, top = 20))
        if (phone.isNotEmpty() && phone != name) root.addView(text(phone, 15f, color = "#D1FAE5", top = 6))
        root.addView(text("Incoming call…", 15f, color = "#D1FAE5", top = 10))

        val spacer = android.view.View(this).apply { layoutParams = LinearLayout.LayoutParams(1, 0, 1f) }
        root.addView(spacer)

        val row = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER
            layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT)
        }
        fun callButton(icon: Int, color: String, label: String, onClick: () -> Unit): LinearLayout =
            LinearLayout(this).apply {
                orientation = LinearLayout.VERTICAL
                gravity = Gravity.CENTER
                layoutParams = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f)
                addView(ImageButton(this@IncomingCallActivity).apply {
                    setImageResource(icon)
                    background = GradientDrawable().apply { shape = GradientDrawable.OVAL; setColor(Color.parseColor(color)) }
                    layoutParams = LinearLayout.LayoutParams(dp(76), dp(76))
                    setOnClickListener { onClick() }
                    contentDescription = label
                })
                addView(text(label, 14f, top = 8))
            }
        row.addView(callButton(R.drawable.ic_call_end, "#EF4444", "Decline") { decline() })
        row.addView(callButton(R.drawable.ic_call_answer, "#22C55E", "Answer") { answer() })
        root.addView(row)
        setContentView(root)
    }

    private fun answer() {
        WaCallNotifier.clear(this, callId)
        // MainActivity shows the call over the lock screen too (no unlock needed)
        startActivity(WaCallNotifier.answerIntent(this, callId))
        finish()
    }

    private fun decline() {
        startService(Intent(this, NotificationSyncService::class.java).apply {
            action = NotificationSyncService.ACTION_WA_DECLINE
            putExtra("call_id", callId)
        })
        finish()
    }

    override fun onDestroy() {
        super.onDestroy()
        try { unregisterReceiver(clearReceiver) } catch (e: Exception) { }
    }
}
