package com.leadorbit.syncer

import android.Manifest
import android.content.ContentUris
import android.content.Context
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.provider.CallLog
import android.provider.MediaStore
import android.util.Log
import androidx.core.content.ContextCompat
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import okhttp3.MediaType.Companion.toMediaTypeOrNull
import okhttp3.MultipartBody
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.asRequestBody
import org.json.JSONObject
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone
import java.util.concurrent.TimeUnit

/**
 * AI call summaries: Android does not let apps record calls, so the phone's own
 * call recorder (Samsung / Xiaomi / Vivo / Oppo / Realme ... "auto record calls")
 * does the recording. After each call this worker finds that call's recording,
 * uploads it to the CRM (Gemini summarises it there, then the server deletes it)
 * and, once the server has it, deletes the recording from the phone too.
 * Calls shorter than MIN_SECONDS are ignored; the server additionally skips calls
 * with our own team / admin numbers.
 */
class RecordingSyncWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {

    companion object {
        private const val TAG = "RecordingSync"
        private const val MIN_SECONDS = 20
        private const val PREF_MARK = "rec_watermark"
        private const val GIVE_UP_AFTER_MS = 20 * 60 * 1000L     // recording never appeared
        private const val MAX_BYTES = 40L * 1024 * 1024
        private const val UPLOAD_URL = "https://crm.mangalamagro.in/api/calls/recording"
        private const val CONFIG_URL = "https://crm.mangalamagro.in/api/calls/recording-config"

        // Folders the common Indian phone brands' built-in recorders write to
        private val KNOWN_DIRS = listOf(
            "Recordings/Call", "Recordings/Call recordings", "Recordings/Call Recordings", "Call",
            "MIUI/sound_recorder/call_rec", "Record/Call", "Recordings/Record/Call", "Record/PhoneRecord",
            "Music/Recordings/Call Recordings", "PhoneRecord", "CallRecordings", "Sounds/CallRecord",
            "Recorder/call", "Recordings/Calls"
        )

        /** Run shortly after a call ends (and chain behind a run already in progress). */
        fun enqueueSoon(context: Context, delaySeconds: Long = 25) {
            val req = OneTimeWorkRequestBuilder<RecordingSyncWorker>()
                .setInitialDelay(delaySeconds, TimeUnit.SECONDS)
                .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
                .build()
            WorkManager.getInstance(context.applicationContext)
                .enqueueUniqueWork("RecordingSyncSoon", ExistingWorkPolicy.APPEND_OR_REPLACE, req)
        }

        fun hasAudioReadPermission(context: Context): Boolean {
            val perm = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU)
                Manifest.permission.READ_MEDIA_AUDIO else Manifest.permission.READ_EXTERNAL_STORAGE
            return ContextCompat.checkSelfPermission(context, perm) == PackageManager.PERMISSION_GRANTED
        }

        /** Android 11+: "All files access". Android 10 and older: storage write permission
         *  (+ requestLegacyExternalStorage in the manifest for Android 10). */
        fun canDeleteOthersFiles(context: Context): Boolean =
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) Environment.isExternalStorageManager()
            else ContextCompat.checkSelfPermission(context, Manifest.permission.WRITE_EXTERNAL_STORAGE) == PackageManager.PERMISSION_GRANTED
    }

    private data class CallEntry(val number: String, val date: Long, val duration: Int, val incoming: Boolean)
    private data class Recording(val uri: Uri?, val file: File?, val name: String)

    private val prefs = context.getSharedPreferences("CRM_PREFS", Context.MODE_PRIVATE)
    private val http = OkHttpClient.Builder()
        .connectTimeout(30, TimeUnit.SECONDS).writeTimeout(180, TimeUnit.SECONDS).readTimeout(60, TimeUnit.SECONDS)
        .build()

    override suspend fun doWork(): Result {
        val token = prefs.getString("auth_token", null) ?: return Result.success()
        if (!hasAudioReadPermission(applicationContext)) return Result.success()
        if (ContextCompat.checkSelfPermission(applicationContext, Manifest.permission.READ_CALL_LOG)
            != PackageManager.PERMISSION_GRANTED) return Result.success()

        // Ask the CRM first: summaries off for this user (or for admins) -> touch nothing
        val cfg = fetchConfig(token) ?: return Result.retry()
        if (!cfg.optBoolean("enabled", false)) {
            // keep the mark at "now" so switching it on later never uploads a backlog
            prefs.edit().putLong(PREF_MARK, System.currentTimeMillis()).apply()
            return Result.success()
        }
        val minSeconds = cfg.optInt("min_seconds", MIN_SECONDS)
        val autoDelete = cfg.optBoolean("auto_delete", true)

        var mark = prefs.getLong(PREF_MARK, 0L)
        if (mark == 0L) {
            // First run: only calls from now on (never upload an old backlog)
            prefs.edit().putLong(PREF_MARK, System.currentTimeMillis()).apply()
            return Result.success()
        }
        val now = System.currentTimeMillis()
        for (call in callsSince(mark, minSeconds)) {
            val end = call.date + call.duration * 1000L
            if (now < end + 15_000L) break                      // recorder may still be writing
            val rec = findRecording(call)
            if (rec == null) {
                if (now - end < GIVE_UP_AFTER_MS) break         // not indexed yet - try next run
                Log.d(TAG, "no recording found for call at ${call.date}, skipping")
            } else {
                when (val res = upload(token, call, rec)) {
                    null -> return Result.retry()               // network / server error - keep mark
                    else -> if (res && autoDelete) deleteLocal(rec)
                }
            }
            mark = call.date
            prefs.edit().putLong(PREF_MARK, mark).apply()
        }
        return Result.success()
    }

    private fun fetchConfig(token: String): JSONObject? = try {
        http.newCall(Request.Builder().url(CONFIG_URL).addHeader("Authorization", "Bearer $token").build())
            .execute().use { r -> if (r.isSuccessful) JSONObject(r.body?.string() ?: "{}") else null }
    } catch (e: Exception) {
        Log.w(TAG, "config fetch failed: ${e.message}"); null
    }

    private fun callsSince(mark: Long, minSeconds: Int): List<CallEntry> {
        val out = mutableListOf<CallEntry>()
        val cursor = applicationContext.contentResolver.query(
            CallLog.Calls.CONTENT_URI,
            arrayOf(CallLog.Calls.NUMBER, CallLog.Calls.DATE, CallLog.Calls.DURATION, CallLog.Calls.TYPE),
            "${CallLog.Calls.DATE} > ? AND ${CallLog.Calls.DURATION} >= ?",
            arrayOf(mark.toString(), maxOf(1, minSeconds).toString()),
            "${CallLog.Calls.DATE} ASC"
        ) ?: return out
        cursor.use {
            while (it.moveToNext() && out.size < 30) {
                val number = it.getString(0) ?: continue
                val type = it.getInt(3)
                if (type != CallLog.Calls.INCOMING_TYPE && type != CallLog.Calls.OUTGOING_TYPE) continue
                if (number.isBlank()) continue
                out.add(CallEntry(number, it.getLong(1), it.getInt(2), type == CallLog.Calls.INCOMING_TYPE))
            }
        }
        return out
    }

    private fun digitsTail(number: String): String = number.filter { it.isDigit() }.takeLast(7)

    /** The recording of this call: MediaStore first, then the brands' known folders. */
    private fun findRecording(call: CallEntry): Recording? {
        val startS = call.date / 1000
        val endS = (call.date + call.duration * 1000L) / 1000
        val tail = digitsTail(call.number)
        val wantMs = call.duration * 1000L
        var best: Recording? = null
        var bestScore = Long.MAX_VALUE
        try {
            val cols = mutableListOf(
                MediaStore.Audio.Media._ID, MediaStore.Audio.Media.DISPLAY_NAME, MediaStore.Audio.Media.DATA,
                MediaStore.Audio.Media.DURATION, MediaStore.Audio.Media.SIZE
            )
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) cols.add(MediaStore.Audio.Media.RELATIVE_PATH)
            val sel = "(${MediaStore.Audio.Media.DATE_ADDED} BETWEEN ? AND ?) OR (${MediaStore.Audio.Media.DATE_MODIFIED} BETWEEN ? AND ?)"
            val a = (startS - 10).toString(); val b = (endS + 900).toString()
            applicationContext.contentResolver.query(
                MediaStore.Audio.Media.EXTERNAL_CONTENT_URI, cols.toTypedArray(), sel, arrayOf(a, b, a, b), null
            )?.use { c ->
                while (c.moveToNext()) {
                    val id = c.getLong(0)
                    val name = c.getString(1) ?: ""
                    val data = c.getString(2) ?: ""
                    val dur = c.getLong(3)
                    val size = c.getLong(4)
                    val rel = if (cols.size > 5) (c.getString(5) ?: "") else ""
                    val where = "$rel/$data/$name".lowercase()
                    if (where.contains("whatsapp") || where.contains("com.leadorbit")) continue
                    if (size <= 0 || size > MAX_BYTES) continue
                    val looksLikeCall = where.contains("call") || where.contains("record")
                    val hasNumber = tail.length >= 6 && name.filter { it.isDigit() }.contains(tail)
                    if (!looksLikeCall && !hasNumber) continue
                    val diff = if (dur > 0) Math.abs(dur - wantMs) else if (hasNumber) 0L else 60_000L
                    val tolerance = maxOf(8_000L, wantMs * 15 / 100)
                    if (diff > tolerance && !hasNumber) continue
                    val score = diff - (if (hasNumber) 5_000L else 0L)
                    if (score < bestScore) {
                        bestScore = score
                        best = Recording(ContentUris.withAppendedId(MediaStore.Audio.Media.EXTERNAL_CONTENT_URI, id),
                            if (data.isNotEmpty()) File(data) else null, name)
                    }
                }
            }
        } catch (e: Exception) {
            Log.w(TAG, "MediaStore query failed: ${e.message}")
        }
        if (best != null) return best
        // Fallback: recorder folders MediaStore did not index (needs all-files access)
        if (!canDeleteOthersFiles(applicationContext)) return null
        val root = Environment.getExternalStorageDirectory()
        var bestFile: File? = null
        var bestDelta = Long.MAX_VALUE
        for (d in KNOWN_DIRS) {
            val dir = File(root, d)
            val files = dir.listFiles() ?: continue
            for (f in files) {
                if (!f.isFile || f.length() <= 0 || f.length() > MAX_BYTES) continue
                val lm = f.lastModified() / 1000
                if (lm < startS - 10 || lm > endS + 900) continue
                val hasNumber = tail.length >= 6 && f.name.filter { it.isDigit() }.contains(tail)
                val delta = Math.abs(lm - endS) - (if (hasNumber) 600 else 0)
                if (delta < bestDelta) { bestDelta = delta; bestFile = f }
            }
        }
        return bestFile?.let { Recording(null, it, it.name) }
    }

    /** true = server has it (delete locally), false = server skipped it, null = try again later. */
    private fun upload(token: String, call: CallEntry, rec: Recording): Boolean? {
        val tmp = File(applicationContext.cacheDir, "rec_upload_${call.date}")
        try {
            val input = when {
                rec.uri != null -> applicationContext.contentResolver.openInputStream(rec.uri)
                rec.file != null -> rec.file.inputStream()
                else -> null
            } ?: return false
            input.use { inp -> tmp.outputStream().use { inp.copyTo(it) } }
            val sdf = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US).apply { timeZone = TimeZone.getTimeZone("UTC") }
            val body = MultipartBody.Builder().setType(MultipartBody.FORM)
                .addFormDataPart("phone", call.number)
                .addFormDataPart("timestamp", sdf.format(Date(call.date)))
                .addFormDataPart("duration_seconds", call.duration.toString())
                .addFormDataPart("direction", if (call.incoming) "incoming" else "outgoing")
                .addFormDataPart("file", rec.name.ifBlank { "call.m4a" }, tmp.asRequestBody("application/octet-stream".toMediaTypeOrNull()))
                .build()
            val req = Request.Builder().url(UPLOAD_URL).addHeader("Authorization", "Bearer $token").post(body).build()
            http.newCall(req).execute().use { resp ->
                if (resp.code >= 500 || resp.code == 401) return null
                if (!resp.isSuccessful) {
                    Log.w(TAG, "upload rejected ${resp.code}")
                    return false
                }
                val json = JSONObject(resp.body?.string() ?: "{}")
                Log.d(TAG, "uploaded call ${call.date}: $json")
                return json.optBoolean("delete_local", false)
            }
        } catch (e: Exception) {
            Log.w(TAG, "upload failed: ${e.message}")
            return null
        } finally {
            tmp.delete()
        }
    }

    /** Delete the phone's copy once the server has it (needs "All files access"). */
    private fun deleteLocal(rec: Recording) {
        if (!canDeleteOthersFiles(applicationContext)) {
            Log.d(TAG, "no permission to delete other apps' files - keeping local recording ${rec.name}")
            return
        }
        try {
            var gone = false
            if (rec.file != null && rec.file.exists()) {
                gone = rec.file.delete()
                if (gone) android.media.MediaScannerConnection.scanFile(applicationContext, arrayOf(rec.file.absolutePath), null, null)
            }
            if (rec.uri != null) {
                try { applicationContext.contentResolver.delete(rec.uri, null, null); gone = true } catch (_: Exception) { }
            }
            Log.d(TAG, "local recording ${rec.name} deleted=$gone")
        } catch (e: Exception) {
            Log.w(TAG, "could not delete ${rec.name}: ${e.message}")
        }
    }
}
