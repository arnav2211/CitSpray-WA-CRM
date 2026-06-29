package com.leadorbit.syncer

import android.content.Context
import android.media.MediaRecorder
import android.util.Log
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

object CallRecorder {
    private var mediaRecorder: MediaRecorder? = null
    private var isRecording = false
    private var outputFile: File? = null

    fun startRecording(context: Context, phoneNumber: String) {
        if (isRecording) return
        try {
            val dir = File(context.getExternalFilesDir(null), "CallRecordings")
            if (!dir.exists()) {
                dir.mkdirs()
            }
            
            val timestamp = SimpleDateFormat("yyyyMMdd_HHmmss", Locale.getDefault()).format(Date())
            val cleanPhone = phoneNumber.replace(Regex("[^0-9+]"), "")
            val filename = "Call_${cleanPhone}_${timestamp}.mp4"
            outputFile = File(dir, filename)

            @Suppress("DEPRECATION")
            mediaRecorder = if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.S) {
                MediaRecorder(context)
            } else {
                MediaRecorder()
            }.apply {
                setAudioSource(MediaRecorder.AudioSource.VOICE_COMMUNICATION)
                setOutputFormat(MediaRecorder.OutputFormat.MPEG_4)
                setAudioEncoder(MediaRecorder.AudioEncoder.AAC)
                setAudioEncodingBitRate(96000)
                setAudioSamplingRate(44100)
                setOutputFile(outputFile!!.absolutePath)
                prepare()
                start()
            }
            isRecording = true
            Log.d("CallRecorder", "Started call recording: ${outputFile!!.absolutePath}")
        } catch (e: Exception) {
            Log.e("CallRecorder", "Failed to start recording call: ${e.message}", e)
            isRecording = false
            mediaRecorder = null
            outputFile = null
        }
    }

    fun stopRecording(): String? {
        if (!isRecording) return null
        try {
            mediaRecorder?.apply {
                stop()
                release()
            }
            val path = outputFile?.absolutePath
            Log.d("CallRecorder", "Stopped call recording. Saved to: $path")
            return path
        } catch (e: Exception) {
            Log.e("CallRecorder", "Failed to stop recording call: ${e.message}", e)
            return null
        } finally {
            isRecording = false
            mediaRecorder = null
            outputFile = null
        }
    }

    fun isRecording(): Boolean {
        return isRecording
    }
}
