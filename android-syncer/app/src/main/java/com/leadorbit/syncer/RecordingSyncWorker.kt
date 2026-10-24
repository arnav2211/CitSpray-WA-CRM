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
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
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
 * does the recording. This worker finds each call's recording and uploads it to the CRM.
 *
 * 2.2.3:
 *  - catches up: every run re-checks the LAST 72 HOURS of calls and uploads any
 *    recording not sent yet (a missed permission / reinstall no longer loses calls)
 *  - the phone's copy is deleted only AFTER the CRM has finished the AI summary
 *  - after every run it reports its health (model, permissions, found / not found,
 *    where the recorder saves) to the CRM -> Settings -> Calls & AI -> Phones
 */
class RecordingSyncWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {

    companion object {
        private const val TAG = "RecordingSync"
        private const val MIN_SECONDS = 10
        private const val BACKFILL_MS = 72 * 3600 * 1000L          // re-check this far back, every run
        private const val PREF_DONE = "rec_done_v2"                 // call dates (ms) already handled
        private const val PREF_USED = "rec_used_files"              // recording files already sent (never reuse one)
        private const val PREF_PENDING_DELETE = "rec_pending_delete" // uploaded, delete after the AI summary
        private const val MAX_UPLOADS_PER_RUN = 15
        private const val MAX_BYTES = 40L * 1024 * 1024
        private const val BASE = "https://crm.mangalamagro.in/api"
        private const val UPLOAD_URL = "$BASE/calls/recording"
        private const val CONFIG_URL = "$BASE/calls/recording-config"
        private const val STATUS_URL = "$BASE/calls/recordings/status"
        private const val HEALTH_URL = "$BASE/calls/phone-status"

        // Folders the common Indian phone brands' built-in recorders write to
        private val KNOWN_DIRS = listOf(
            "Recordings/Call", "Recordings/Call recordings", "Recordings/Call Recordings", "Call",
            "MIUI/sound_recorder/call_rec", "Record/Call", "Recordings/Record/Call", "Record/PhoneRecord",
            "Music/Recordings/Call Recordings", "PhoneRecord", "CallRecordings", "Sounds/CallRecord",
            "Recorder/call", "Recordings/Calls", "Music/Call Recordings", "Recordings/Sound records/Call"
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
    private val usedFiles: MutableSet<String> by lazy { prefs.getStringSet(PREF_USED, emptySet())!!.toMutableSet() }

    /** Recording start time written in the file name (Cube ACR, Samsung, Vivo ...), epoch seconds - or null.
     *  The phone number digits are removed first so they can't be mistaken for a date. */
    private fun nameTime(name: String, tail: String): Long? {
        var n = name
        if (tail.length >= 6) n = n.replace(Regex("\\+?\\d*" + tail), " ")
        val pats = listOf(
            Regex("(20\\d{2})[-_.]?(\\d{2})[-_.]?(\\d{2})[ _\\-T.@]?(\\d{2})[-_.:]?(\\d{2})[-_.:]?(\\d{2})") to "ymd",
            Regex("(\\d{2})[-_.](\\d{2})[-_.](20\\d{2})[ _\\-@]?(\\d{2})[-_.:]?(\\d{2})[-_.:]?(\\d{2})") to "dmy")
        for ((re, kind) in pats) {
            val m = re.find(n) ?: continue
            val g = m.groupValues.drop(1).map { it.toInt() }
            val (y, mo, d) = if (kind == "ymd") Triple(g[0], g[1], g[2]) else Triple(g[2], g[1], g[0])
            if (mo !in 1..12 || d !in 1..31 || g[3] > 23 || g[4] > 59 || g[5] > 59) continue
            val cal = java.util.Calendar.getInstance()
            cal.set(y, mo - 1, d, g[3], g[4], g[5]); cal.set(java.util.Calendar.MILLISECOND, 0)
            return cal.timeInMillis / 1000
        }
        return null
    }

    /** False when the name carries a time that does not belong to this call (an old recording). */
    private fun nameTimeFits(name: String, tail: String, startS: Long, endS: Long): Boolean {
        val t = nameTime(name, tail) ?: return true
        return Math.abs(t - startS) <= 180 || Math.abs(t - endS) <= 180
    }

    private val prefs = context.getSharedPreferences("CRM_PREFS", Context.MODE_PRIVATE)
    private val http = OkHttpClient.Builder()
        .connectTimeout(30, TimeUnit.SECONDS).writeTimeout(180, TimeUnit.SECONDS).readTimeout(60, TimeUnit.SECONDS)
        .build()

    // health report for this run
    private val health = JSONObject()
    private var scanned = 0
    private var found = 0
    private var uploaded = 0
    private var notFound = 0
    private var lastError = ""

    override suspend fun doWork(): Result {
        val token = prefs.getString("auth_token", null) ?: return Result.success()
        val audioOk = hasAudioReadPermission(applicationContext)
        val callLogOk = ContextCompat.checkSelfPermission(applicationContext, Manifest.permission.READ_CALL_LOG) ==
            PackageManager.PERMISSION_GRANTED
        health.put("audio_permission", audioOk).put("calllog_permission", callLogOk)
            .put("delete_permission", canDeleteOthersFiles(applicationContext))
        if (!audioOk || !callLogOk) {
            lastError = if (!audioOk) "No 'Music and audio' / storage permission" else "No call log permission"
            report(token)
            return Result.success()
        }

        // Ask the CRM first: summaries off for this user (or for admins) -> touch nothing
        val cfg = fetchConfig(token) ?: run { report(token); return Result.retry() }
        if (!cfg.optBoolean("enabled", false)) {
            health.put("enabled", false)
            report(token)
            return Result.success()
        }
        val minSeconds = cfg.optInt("min_seconds", MIN_SECONDS)
        val autoDelete = cfg.optBoolean("auto_delete", true)

        // 1) delete the phone's copies whose AI summary is now finished
        if (autoDelete) deleteSummarised(token)

        // 2) every call of the last 72 h that is not handled yet
        val done = prefs.getStringSet(PREF_DONE, emptySet())!!.toMutableSet()
        val now = System.currentTimeMillis()
        val since = now - BACKFILL_MS
        done.removeAll { (it.toLongOrNull() ?: 0L) < since }       // forget old entries
        for (call in callsSince(since, minSeconds)) {
            if (uploaded >= MAX_UPLOADS_PER_RUN) break
            if (done.contains(call.date.toString())) continue
            val end = call.date + call.duration * 1000L
            if (now < end + 15_000L) continue                       // recorder may still be writing
            scanned++
            val rec = findRecording(call)
            if (rec == null) { notFound++; continue }                // try again next run (until 72 h old)
            found++
            if (!health.has("last_found_at") || health.optLong("last_found_at") < end) health.put("last_found_at", end)
            val res = upload(token, call, rec)
            if (res == null) { prefs.edit().putStringSet(PREF_DONE, done).apply(); report(token); return Result.retry() }
            done.add(call.date.toString())
            usedFiles.add(rec.name)
            if (usedFiles.size > 1500) usedFiles.clear()
            prefs.edit().putStringSet(PREF_DONE, done).putStringSet(PREF_USED, HashSet(usedFiles)).apply()
            uploaded++
            val rid = res.optString("id")
            val keep = res.optString("skipped").isNotEmpty() || !res.optBoolean("delete_local", false)
            if (autoDelete && !keep && rid.isNotEmpty()) addPendingDelete(rid, rec)
        }
        prefs.edit().putStringSet(PREF_DONE, done).apply()
        report(token)
        return Result.success()
    }

    private fun fetchConfig(token: String): JSONObject? = try {
        http.newCall(Request.Builder().url(CONFIG_URL).addHeader("Authorization", "Bearer $token").build())
            .execute().use { r -> if (r.isSuccessful) JSONObject(r.body?.string() ?: "{}") else { lastError = "config HTTP ${r.code}"; null } }
    } catch (e: Exception) {
        lastError = "config: ${e.message}"; Log.w(TAG, "config fetch failed: ${e.message}"); null
    }

    private fun callsSince(since: Long, minSeconds: Int): List<CallEntry> {
        val out = mutableListOf<CallEntry>()
        val cursor = applicationContext.contentResolver.query(
            CallLog.Calls.CONTENT_URI,
            arrayOf(CallLog.Calls.NUMBER, CallLog.Calls.DATE, CallLog.Calls.DURATION, CallLog.Calls.TYPE),
            "${CallLog.Calls.DATE} > ? AND ${CallLog.Calls.DURATION} >= ?",
            arrayOf(since.toString(), maxOf(1, minSeconds).toString()),
            "${CallLog.Calls.DATE} DESC"                            // newest first: today's calls first
        ) ?: return out
        cursor.use {
            while (it.moveToNext() && out.size < 400) {
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
                    if (usedFiles.contains(name)) continue
                    if (!nameTimeFits(name, tail, startS, endS)) continue
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
            lastError = "MediaStore: ${e.message}"
            Log.w(TAG, "MediaStore query failed: ${e.message}")
        }
        if (best != null) return best
        // Fallback: recorder folders MediaStore did not index (needs all-files access)
        if (!canDeleteOthersFiles(applicationContext)) return null
        val root = Environment.getExternalStorageDirectory()
        var bestFile: File? = null
        var bestDelta = Long.MAX_VALUE
        // known brand folders + any CubeCallRecorder folder (Cube ACR hides its files from
        // MediaStore with .nomedia, so they are read straight from disk, sub-folders included)
        val dirs = KNOWN_DIRS.map { File(root, it) } + cubeDirs(root)
        for (dir in dirs) {
            val files = filesUnder(dir, 3)
            for (f in files) {
                if (!f.isFile || f.length() <= 0 || f.length() > MAX_BYTES) continue
                if (usedFiles.contains(f.name)) continue
                val nt = nameTime(f.name, tail)
                val lm = f.lastModified() / 1000
                if (nt != null) {
                    if (!nameTimeFits(f.name, tail, startS, endS)) continue       // an older recording
                } else if (lm < startS - 10 || lm > endS + 300) continue
                val hasNumber = tail.length >= 6 && f.name.filter { it.isDigit() }.contains(tail)
                val delta = Math.abs(lm - endS) - (if (hasNumber) 600 else 0)
                if (delta < bestDelta) { bestDelta = delta; bestFile = f }
            }
        }
        return bestFile?.let { Recording(null, it, it.name) }
    }

    /** Server's JSON reply; null = try again later (network / server error). */
    private fun upload(token: String, call: CallEntry, rec: Recording): JSONObject? {
        val tmp = File(applicationContext.cacheDir, "rec_upload_${call.date}")
        try {
            val input = when {
                rec.uri != null -> applicationContext.contentResolver.openInputStream(rec.uri)
                rec.file != null -> rec.file.inputStream()
                else -> null
            } ?: return JSONObject().put("skipped", "unreadable")
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
                if (resp.code >= 500 || resp.code == 401) { lastError = "upload HTTP ${resp.code}"; return null }
                if (!resp.isSuccessful) {
                    lastError = "upload rejected HTTP ${resp.code}"
                    return JSONObject().put("skipped", "http ${resp.code}")
                }
                val json = JSONObject(resp.body?.string() ?: "{}")
                Log.d(TAG, "uploaded call ${call.date}: $json")
                return json
            }
        } catch (e: Exception) {
            lastError = "upload: ${e.message}"
            Log.w(TAG, "upload failed: ${e.message}")
            return null
        } finally {
            tmp.delete()
        }
    }

    // ---- delete the phone's copy only after the CRM finished the AI summary ----

    private fun pending(): JSONArray = try { JSONArray(prefs.getString(PREF_PENDING_DELETE, "[]")) } catch (e: Exception) { JSONArray() }

    private fun addPendingDelete(rid: String, rec: Recording) {
        val arr = pending()
        arr.put(JSONObject().put("id", rid).put("uri", rec.uri?.toString() ?: "").put("path", rec.file?.absolutePath ?: "")
            .put("name", rec.name).put("at", System.currentTimeMillis()))
        prefs.edit().putString(PREF_PENDING_DELETE, arr.toString()).apply()
    }

    private fun deleteSummarised(token: String) {
        val arr = pending()
        if (arr.length() == 0) return
        val ids = (0 until arr.length()).joinToString(",") { arr.getJSONObject(it).optString("id") }
        val statuses = try {
            http.newCall(Request.Builder().url("$STATUS_URL?ids=$ids").addHeader("Authorization", "Bearer $token").build())
                .execute().use { r -> if (r.isSuccessful) JSONObject(r.body?.string() ?: "{}") else null }
        } catch (e: Exception) { null } ?: return
        val keep = JSONArray()
        for (i in 0 until arr.length()) {
            val item = arr.getJSONObject(i)
            when (statuses.optString(item.optString("id"))) {
                "done" -> deleteLocal(item)                            // summary finished -> remove from the phone
                "failed", "" -> { }                                   // summary failed / unknown -> keep the file
                else -> if (System.currentTimeMillis() - item.optLong("at") < 3 * 24 * 3600 * 1000L) keep.put(item)
            }
        }
        prefs.edit().putString(PREF_PENDING_DELETE, keep.toString()).apply()
    }

    private fun deleteLocal(item: JSONObject) {
        if (!canDeleteOthersFiles(applicationContext)) return
        try {
            val path = item.optString("path")
            if (path.isNotEmpty()) {
                val f = File(path)
                if (f.exists() && f.delete()) android.media.MediaScannerConnection.scanFile(applicationContext, arrayOf(path), null, null)
            }
            val uri = item.optString("uri")
            if (uri.isNotEmpty()) try { applicationContext.contentResolver.delete(Uri.parse(uri), null, null) } catch (_: Exception) { }
        } catch (e: Exception) {
            Log.w(TAG, "could not delete ${item.optString("name")}: ${e.message}")
        }
    }

    // ---- health report -> CRM Settings -> Calls & AI -> Phones ----

    /** Folders named CubeCallRecorder anywhere in the first levels of storage (not Android/). */
    private fun cubeDirs(root: File): List<File> {
        val out = mutableListOf<File>()
        fun walk(d: File, depth: Int) {
            val kids = d.listFiles() ?: return
            for (k in kids) {
                if (!k.isDirectory || k.name.startsWith(".")) continue
                if (depth == 0 && k.name.equals("Android", ignoreCase = true)) continue
                if (k.name.equals("CubeCallRecorder", ignoreCase = true)) { out.add(k); continue }
                if (depth < 3) walk(k, depth + 1)
            }
        }
        try { walk(root, 0) } catch (_: Exception) { }
        return out
    }

    /** Audio files in a folder and its sub-folders (up to maxDepth levels). */
    private fun filesUnder(dir: File, maxDepth: Int): List<File> {
        val out = mutableListOf<File>()
        fun walk(d: File, depth: Int) {
            val kids = d.listFiles() ?: return
            for (k in kids) {
                if (k.isDirectory) { if (depth < maxDepth && !k.name.startsWith(".")) walk(k, depth + 1) }
                else if (!k.name.startsWith(".")) out.add(k)
            }
        }
        try { walk(dir, 0) } catch (_: Exception) { }
        return out
    }

    /** Where this phone's recorder saves (folders with call-like audio from the last 7 days). */
    private fun recorderFolders(): JSONArray {
        val counts = LinkedHashMap<String, Int>()
        try {
            val cols = mutableListOf(MediaStore.Audio.Media.DATA, MediaStore.Audio.Media.DISPLAY_NAME)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) cols.add(MediaStore.Audio.Media.RELATIVE_PATH)
            val since = (System.currentTimeMillis() / 1000 - 7 * 86400).toString()
            applicationContext.contentResolver.query(MediaStore.Audio.Media.EXTERNAL_CONTENT_URI, cols.toTypedArray(),
                "${MediaStore.Audio.Media.DATE_ADDED} > ?", arrayOf(since), null)?.use { c ->
                while (c.moveToNext()) {
                    val data = c.getString(0) ?: ""
                    val rel = if (cols.size > 2) (c.getString(2) ?: "") else ""
                    val folder = (if (rel.isNotEmpty()) rel else File(data).parent ?: "").trimEnd('/')
                    val low = folder.lowercase()
                    if (low.contains("whatsapp") || low.contains("leadorbit")) continue
                    if (!(low.contains("call") || low.contains("record"))) continue
                    counts[folder] = (counts[folder] ?: 0) + 1
                }
            }
        } catch (_: Exception) { }
        // Cube ACR folders are hidden from MediaStore - count their recent files on disk
        try {
            if (canDeleteOthersFiles(applicationContext)) {
                val sinceMs = System.currentTimeMillis() - 7L * 86400_000L
                for (d in cubeDirs(Environment.getExternalStorageDirectory())) {
                    val fs = filesUnder(d, 3)
                    val n = fs.count { it.lastModified() > sinceMs }
                    counts["fs:" + d.absolutePath.substringAfter("/0/")] = n
                    fs.sortedByDescending { it.lastModified() }.take(2).forEach { counts["sample:" + it.name] = 0 }
                }
            }
        } catch (_: Exception) { }
        val out = JSONArray()
        counts.entries.sortedByDescending { it.value }.take(5).forEach { out.put("${it.key} (${it.value})") }
        return out
    }

    private fun report(token: String) {
        try {
            val v = try { applicationContext.packageManager.getPackageInfo(applicationContext.packageName, 0).versionName } catch (e: Exception) { "" }
            health.put("app_version", v)
                .put("device", "${Build.MANUFACTURER} ${Build.MODEL}")
                .put("android", Build.VERSION.RELEASE)
                .put("scanned", scanned).put("found", found).put("uploaded", uploaded).put("not_found", notFound)
                .put("last_error", lastError)
                .put("recorder_folders", recorderFolders())
                .put("pending_delete", pending().length())
            if (!health.has("last_found_at")) health.put("last_found_at", 0)
            val body = health.toString().toRequestBody("application/json".toMediaTypeOrNull())
            http.newCall(Request.Builder().url(HEALTH_URL).addHeader("Authorization", "Bearer $token").post(body).build())
                .execute().close()
        } catch (e: Exception) {
            Log.w(TAG, "health report failed: ${e.message}")
        }
    }
}
