package com.leadorbit.syncer

import android.Manifest
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.res.ColorStateList
import android.graphics.Color
import android.media.AudioManager
import android.media.ToneGenerator
import android.net.Uri
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.provider.ContactsContract
import android.telecom.Call
import android.util.Log
import android.view.View
import android.widget.Button
import android.widget.Chronometer
import android.widget.ImageButton
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat

class CallActivity : AppCompatActivity() {

    private lateinit var callerInitial: TextView
    private lateinit var callerName: TextView
    private lateinit var callerNumber: TextView
    private lateinit var callStatus: TextView
    private lateinit var callTimer: Chronometer
    private lateinit var muteButton: ImageButton
    private lateinit var muteLabel: TextView
    private lateinit var speakerButton: ImageButton
    private lateinit var speakerLabel: TextView
    private lateinit var hangupButton: ImageButton
    private lateinit var hangupLabel: TextView
    private lateinit var answerButton: ImageButton
    private lateinit var answerContainer: LinearLayout
    private lateinit var controlsContainer: LinearLayout

    // New Dialer, Record, and Conference Buttons
    private lateinit var keypadButton: ImageButton
    private lateinit var recordButton: ImageButton
    private lateinit var recordLabel: TextView
    private lateinit var addCallButton: ImageButton
    private lateinit var mergeContainer: LinearLayout
    private lateinit var mergeButton: ImageButton

    // DTMF Overlay Views
    private lateinit var dtmfDialerContainer: LinearLayout
    private lateinit var dtmfDisplay: TextView
    private lateinit var dtmfHideButton: Button

    private var isMuted = false
    private var isSpeakerOn = false
    private var isDtmfVisible = false
    private var isTimerRunning = false
    
    private var toneGenerator: ToneGenerator? = null
    private var phoneNumber: String = ""

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_call)

        // Show over lockscreen
        if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.O_MR1) {
            setShowWhenLocked(true)
            setTurnScreenOn(true)
        } else {
            @Suppress("DEPRECATION")
            window.addFlags(
                android.view.WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED
                        or android.view.WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON
                        or android.view.WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON
            )
        }

        callerInitial = findViewById(R.id.callerInitial)
        callerName = findViewById(R.id.callerName)
        callerNumber = findViewById(R.id.callerNumber)
        callStatus = findViewById(R.id.callStatus)
        callTimer = findViewById(R.id.callTimer)
        muteButton = findViewById(R.id.muteButton)
        muteLabel = findViewById(R.id.muteLabel)
        speakerButton = findViewById(R.id.speakerButton)
        speakerLabel = findViewById(R.id.speakerLabel)
        hangupButton = findViewById(R.id.hangupButton)
        hangupLabel = findViewById(R.id.hangupLabel)
        answerButton = findViewById(R.id.answerButton)
        answerContainer = findViewById(R.id.answerContainer)
        controlsContainer = findViewById(R.id.controlsContainer)

        // Bind New Controls
        keypadButton = findViewById(R.id.keypadButton)
        recordButton = findViewById(R.id.recordButton)
        recordLabel = findViewById(R.id.recordLabel)
        addCallButton = findViewById(R.id.addCallButton)
        mergeContainer = findViewById(R.id.mergeContainer)
        mergeButton = findViewById(R.id.mergeButton)

        // Bind DTMF Overlay
        dtmfDialerContainer = findViewById(R.id.dtmfDialerContainer)
        dtmfDisplay = findViewById(R.id.dtmfDisplay)
        dtmfHideButton = findViewById(R.id.dtmfHideButton)

        // Initialize local tone generator for DTMF key feedback
        try {
            toneGenerator = ToneGenerator(AudioManager.STREAM_VOICE_CALL, 80)
        } catch (e: Exception) {
            Log.e("CallActivity", "Failed to initialize ToneGenerator: ${e.message}")
        }

        val activeCall = CallService.activeCall
        if (activeCall == null) {
            finish()
            return
        }

        // Display caller details
        val uri = activeCall.details.handle
        phoneNumber = uri?.schemeSpecificPart ?: "Unknown"
        callerNumber.text = phoneNumber

        // Resolve Dual Name (Contact name + CRM name)
        resolveNames(phoneNumber)

        // Register call state listener
        activeCall.registerCallback(callCallback)
        updateCallState(activeCall.state)
        checkConferenceState()

        // Mute toggle
        muteButton.setOnClickListener {
            isMuted = !isMuted
            CallService.mute(isMuted)
            updateMuteUI()
        }

        // Speaker toggle
        speakerButton.setOnClickListener {
            isSpeakerOn = !isSpeakerOn
            CallService.toggleSpeaker(isSpeakerOn)
            updateSpeakerUI()
        }

        // Keypad toggle (DTMF) — the keypad replaces the controls grid while open
        keypadButton.setOnClickListener {
            if (isDtmfVisible) hideDtmfKeypad() else showDtmfKeypad()
        }
        dtmfHideButton.setOnClickListener {
            hideDtmfKeypad()
        }

        // Record call toggle
        recordButton.setOnClickListener {
            if (ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
                Toast.makeText(this, "Microphone permission required to record calls", Toast.LENGTH_SHORT).show()
                return@setOnClickListener
            }

            if (CallRecorder.isRecording()) {
                val path = CallRecorder.stopRecording()
                if (path != null) {
                    Toast.makeText(this, "Recording saved: $path", Toast.LENGTH_LONG).show()
                }
                updateRecordUI()
            } else {
                CallRecorder.startRecording(this, phoneNumber)
                if (CallRecorder.isRecording()) {
                    Toast.makeText(this, "Call recording started...", Toast.LENGTH_SHORT).show()
                }
                updateRecordUI()
            }
        }

        // Add Call (Conference)
        addCallButton.setOnClickListener {
            val intent = Intent(this, DialpadActivity::class.java)
            startActivity(intent)
        }

        // Merge Calls (Conference)
        mergeButton.setOnClickListener {
            val current = CallService.activeCall
            val other = CallService.callsList.firstOrNull { it != current }
            if (current != null && other != null) {
                current.conference(other)
                Toast.makeText(this, "Merging calls into conference...", Toast.LENGTH_SHORT).show()
            }
        }

        // End call (acts as Decline while an incoming call is ringing)
        hangupButton.setOnClickListener {
            val call = CallService.activeCall
            if (call != null && call.state == Call.STATE_RINGING) {
                call.reject(false, null)
            } else {
                CallService.hangUp()
            }
        }

        // Answer call
        answerButton.setOnClickListener {
            val call = CallService.activeCall
            if (call != null && call.state == Call.STATE_RINGING) {
                call.answer(android.telecom.VideoProfile.STATE_AUDIO_ONLY)
            }
        }

        // Wire DTMF keypad button clicks
        setupDtmfKeys()
        updateRecordUI()
    }

    private fun resolveNames(phone: String) {
        // Load leadlookup map if not loaded
        LeadLookup.loadMap(this)
        
        val contactName = getContactName(this, phone)
        val crmLead = LeadLookup.lookup(phone)

        val hasContact = !contactName.isNullOrEmpty()
        val hasCrm = !crmLead?.name.isNullOrEmpty()

        callerName.text = when {
            hasContact && hasCrm && contactName != crmLead?.name -> {
                val statusStr = if (!crmLead?.status.isNullOrEmpty()) " (${crmLead?.status?.uppercase()})" else ""
                "$contactName / ${crmLead?.name}$statusStr [CRM]"
            }
            hasCrm -> {
                val statusStr = if (!crmLead?.status.isNullOrEmpty()) " (${crmLead?.status?.uppercase()})" else ""
                "${crmLead?.name}$statusStr [CRM]"
            }
            hasContact -> "$contactName [Phone]"
            else -> "LeadOrbit Call"
        }

        val initial = (crmLead?.name ?: contactName)?.trim()?.firstOrNull()?.toString()
            ?: phone.filter { it.isDigit() }.lastOrNull()?.toString() ?: "?"
        callerInitial.text = initial.uppercase()
    }

    private fun getContactName(context: Context, phoneNumber: String): String? {
        if (ContextCompat.checkSelfPermission(context, Manifest.permission.READ_CONTACTS) != PackageManager.PERMISSION_GRANTED) {
            return null
        }
        try {
            val uri = Uri.withAppendedPath(ContactsContract.PhoneLookup.CONTENT_FILTER_URI, Uri.encode(phoneNumber))
            val cursor = context.contentResolver.query(uri, arrayOf(ContactsContract.PhoneLookup.DISPLAY_NAME), null, null, null)
            cursor?.use {
                if (it.moveToFirst()) {
                    return it.getString(0)
                }
            }
        } catch (e: Exception) {
            Log.e("CallActivity", "Failed to query Contact name: ${e.message}")
        }
        return null
    }

    private fun checkConferenceState() {
        if (CallService.callsList.size >= 2) {
            mergeContainer.visibility = View.VISIBLE
        } else {
            mergeContainer.visibility = View.GONE
        }
    }

    private fun showDtmfKeypad() {
        isDtmfVisible = true
        dtmfDisplay.text = ""
        dtmfDialerContainer.visibility = View.VISIBLE
        controlsContainer.visibility = View.GONE
    }

    private fun hideDtmfKeypad() {
        isDtmfVisible = false
        dtmfDialerContainer.visibility = View.GONE
        // Restore the controls grid only when the call is not ringing
        val state = CallService.activeCall?.state
        if (state != Call.STATE_RINGING) {
            controlsContainer.visibility = View.VISIBLE
        }
    }

    private fun startTimerFromConnectTime(call: Call) {
        // Base the chronometer on the real connect time so re-opening this
        // screen mid-call keeps the correct elapsed duration
        val connectTime = call.details.connectTimeMillis
        val baseTime = if (connectTime > 0L) {
            SystemClock.elapsedRealtime() - (System.currentTimeMillis() - connectTime)
        } else {
            SystemClock.elapsedRealtime()
        }
        callTimer.base = baseTime
        if (!isTimerRunning) {
            callTimer.start()
            isTimerRunning = true
        }
        callTimer.visibility = View.VISIBLE
    }

    private fun updateCallState(state: Int) {
        val call = CallService.activeCall
        when (state) {
            Call.STATE_DIALING -> {
                callStatus.text = "Dialing..."
                callStatus.setTextColor(Color.parseColor("#FFD60A"))
                callTimer.visibility = View.GONE
                answerContainer.visibility = View.GONE
                hangupLabel.text = "End Call"
                if (!isDtmfVisible) controlsContainer.visibility = View.VISIBLE
            }
            Call.STATE_RINGING -> {
                // Incoming call, not yet answered: show only Answer / Decline —
                // in-call controls (keypad, mute, etc.) make no sense yet
                callStatus.text = "Incoming Call..."
                callStatus.setTextColor(Color.parseColor("#30D158"))
                callTimer.visibility = View.GONE
                answerContainer.visibility = View.VISIBLE
                hangupLabel.text = "Decline"
                hideDtmfKeypad()
                controlsContainer.visibility = View.GONE
            }
            Call.STATE_ACTIVE -> {
                callStatus.text = "Connected"
                callStatus.setTextColor(Color.parseColor("#30D158"))
                answerContainer.visibility = View.GONE
                hangupLabel.text = "End Call"
                if (!isDtmfVisible) controlsContainer.visibility = View.VISIBLE
                if (call != null) startTimerFromConnectTime(call)
            }
            Call.STATE_DISCONNECTED -> {
                callStatus.text = "Call Ended"
                callStatus.setTextColor(Color.parseColor("#FF453A"))
                callTimer.stop()
                isTimerRunning = false
                answerContainer.visibility = View.GONE
                finish()
            }
            else -> {
                callStatus.text = "Connecting..."
                callStatus.setTextColor(Color.parseColor("#8E8E93"))
                answerContainer.visibility = View.GONE
                hangupLabel.text = "End Call"
            }
        }
        checkConferenceState()
    }

    private fun updateMuteUI() {
        if (isMuted) {
            muteButton.setImageResource(R.drawable.ic_mic_off)
            muteButton.backgroundTintList = ColorStateList.valueOf(Color.parseColor("#FFFFFF"))
            muteButton.imageTintList = ColorStateList.valueOf(Color.parseColor("#0A0A0A"))
            muteLabel.text = "Unmute"
            muteLabel.setTextColor(Color.parseColor("#FFFFFF"))
        } else {
            muteButton.setImageResource(R.drawable.ic_mic)
            muteButton.backgroundTintList = ColorStateList.valueOf(Color.parseColor("#1C1D24"))
            muteButton.imageTintList = ColorStateList.valueOf(Color.parseColor("#FFFFFF"))
            muteLabel.text = "Mute"
            muteLabel.setTextColor(Color.parseColor("#A0A5B5"))
        }
    }

    private fun updateSpeakerUI() {
        if (isSpeakerOn) {
            speakerButton.backgroundTintList = ColorStateList.valueOf(Color.parseColor("#FFFFFF"))
            speakerButton.imageTintList = ColorStateList.valueOf(Color.parseColor("#0A0A0A"))
            speakerLabel.text = "Speaker On"
            speakerLabel.setTextColor(Color.parseColor("#FFFFFF"))
        } else {
            speakerButton.backgroundTintList = ColorStateList.valueOf(Color.parseColor("#1C1D24"))
            speakerButton.imageTintList = ColorStateList.valueOf(Color.parseColor("#FFFFFF"))
            speakerLabel.text = "Speaker"
            speakerLabel.setTextColor(Color.parseColor("#A0A5B5"))
        }
    }

    private fun updateRecordUI() {
        if (CallRecorder.isRecording()) {
            recordButton.backgroundTintList = ColorStateList.valueOf(Color.parseColor("#FF3B30")) // Flashing red
            recordButton.imageTintList = ColorStateList.valueOf(Color.parseColor("#FFFFFF"))
            recordLabel.text = "Recording"
            recordLabel.setTextColor(Color.parseColor("#FF3B30"))
        } else {
            recordButton.backgroundTintList = ColorStateList.valueOf(Color.parseColor("#1C1D24"))
            recordButton.imageTintList = ColorStateList.valueOf(Color.parseColor("#FFFFFF"))
            recordLabel.text = "Record"
            recordLabel.setTextColor(Color.parseColor("#A0A5B5"))
        }
    }

    private fun setupDtmfKeys() {
        val dtmfKeys = mapOf(
            R.id.dtmf0 to '0', R.id.dtmf1 to '1', R.id.dtmf2 to '2',
            R.id.dtmf3 to '3', R.id.dtmf4 to '4', R.id.dtmf5 to '5',
            R.id.dtmf6 to '6', R.id.dtmf7 to '7', R.id.dtmf8 to '8',
            R.id.dtmf9 to '9', R.id.dtmfStar to '*', R.id.dtmfHash to '#'
        )

        for ((id, char) in dtmfKeys) {
            findViewById<Button>(id).setOnClickListener {
                playDtmfTone(char)
                dtmfDisplay.append(char.toString())
            }
        }
    }

    private fun playDtmfTone(digit: Char) {
        // Play local feedback tone
        val toneType = when (digit) {
            '0' -> ToneGenerator.TONE_DTMF_0
            '1' -> ToneGenerator.TONE_DTMF_1
            '2' -> ToneGenerator.TONE_DTMF_2
            '3' -> ToneGenerator.TONE_DTMF_3
            '4' -> ToneGenerator.TONE_DTMF_4
            '5' -> ToneGenerator.TONE_DTMF_5
            '6' -> ToneGenerator.TONE_DTMF_6
            '7' -> ToneGenerator.TONE_DTMF_7
            '8' -> ToneGenerator.TONE_DTMF_8
            '9' -> ToneGenerator.TONE_DTMF_9
            '*' -> ToneGenerator.TONE_DTMF_S
            '#' -> ToneGenerator.TONE_DTMF_P
            else -> -1
        }
        if (toneType != -1) {
            toneGenerator?.startTone(toneType, 120)
        }

        // Send remote DTMF to system Call
        CallService.activeCall?.playDtmfTone(digit)
        Handler(Looper.getMainLooper()).postDelayed({
            CallService.activeCall?.stopDtmfTone()
        }, 120)
    }

    private val callCallback = object : Call.Callback() {
        override fun onStateChanged(call: Call, state: Int) {
            super.onStateChanged(call, state)
            runOnUiThread { updateCallState(state) }
        }
    }

    override fun onDestroy() {
        super.onDestroy()
        CallService.activeCall?.unregisterCallback(callCallback)
        toneGenerator?.release()
    }
}
