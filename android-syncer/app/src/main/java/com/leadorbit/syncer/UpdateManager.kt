package com.leadorbit.syncer

import android.app.Activity
import android.app.AlertDialog
import android.app.ProgressDialog
import android.content.Intent
import android.net.Uri
import android.os.Handler
import android.os.Looper
import androidx.core.content.FileProvider
import okhttp3.OkHttpClient
import okhttp3.Request
import org.json.JSONObject
import java.io.File
import java.util.concurrent.TimeUnit

/**
 * In-app self-update: checks /api/app/version on the CRM server, and when a
 * newer versionCode is published shows an "Update available" dialog that
 * downloads the APK and hands it to the system installer — one tap per phone,
 * no more passing APK files around.
 */
object UpdateManager {

    private const val VERSION_URL = "https://crm.mangalamagro.in/api/app/version"

    private val client = OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(120, TimeUnit.SECONDS)
        .build()

    fun checkForUpdate(activity: Activity) {
        Thread {
            try {
                val request = Request.Builder().url(VERSION_URL).build()
                client.newCall(request).execute().use { resp ->
                    if (!resp.isSuccessful) return@use
                    val body = resp.body?.string() ?: return@use
                    val json = JSONObject(body)
                    val remoteCode = json.optLong("version_code", 0)
                    val remoteName = json.optString("version_name", "")
                    val apkUrl = json.optString("apk_url", "")
                    val notes = json.optString("notes", "")
                    if (apkUrl.isEmpty()) return@use

                    val myCode = currentVersionCode(activity)
                    if (remoteCode > myCode) {
                        Handler(Looper.getMainLooper()).post {
                            if (!activity.isFinishing && !activity.isDestroyed) {
                                showUpdateDialog(activity, remoteName, notes, apkUrl)
                            }
                        }
                    }
                }
            } catch (e: Exception) {
                android.util.Log.w("UpdateManager", "update check failed: ${e.message}")
            }
        }.start()
    }

    private fun currentVersionCode(activity: Activity): Long {
        return try {
            val info = activity.packageManager.getPackageInfo(activity.packageName, 0)
            if (android.os.Build.VERSION.SDK_INT >= 28) info.longVersionCode
            else @Suppress("DEPRECATION") info.versionCode.toLong()
        } catch (e: Exception) {
            0L
        }
    }

    private fun showUpdateDialog(activity: Activity, versionName: String, notes: String, apkUrl: String) {
        val message = buildString {
            append("LeadOrbit $versionName is ready to install.")
            if (notes.isNotEmpty()) append("\n\nWhat's new:\n$notes")
        }
        AlertDialog.Builder(activity)
            .setTitle("App update available")
            .setMessage(message)
            .setCancelable(true)
            .setPositiveButton("Install now") { _, _ -> downloadAndInstall(activity, apkUrl) }
            .setNegativeButton("Later", null)
            .show()
    }

    private fun downloadAndInstall(activity: Activity, apkUrl: String) {
        @Suppress("DEPRECATION")
        val progress = ProgressDialog(activity).apply {
            setMessage("Downloading update…")
            setCancelable(false)
            show()
        }
        Thread {
            var error: String? = null
            var apkFile: File? = null
            try {
                val dir = File(activity.cacheDir, "updates").apply { mkdirs() }
                // Clean old downloads
                dir.listFiles()?.forEach { it.delete() }
                val out = File(dir, "leadorbit-update.apk")
                val request = Request.Builder().url(apkUrl).build()
                client.newCall(request).execute().use { resp ->
                    if (!resp.isSuccessful) throw Exception("HTTP ${resp.code}")
                    resp.body?.byteStream()?.use { input ->
                        out.outputStream().use { output -> input.copyTo(output) }
                    } ?: throw Exception("empty body")
                }
                apkFile = out
            } catch (e: Exception) {
                error = e.message
            }
            Handler(Looper.getMainLooper()).post {
                progress.dismiss()
                if (apkFile != null) {
                    launchInstaller(activity, apkFile)
                } else {
                    AlertDialog.Builder(activity)
                        .setTitle("Download failed")
                        .setMessage("Could not download the update ($error). Check the internet connection and try again.")
                        .setPositiveButton("OK", null)
                        .show()
                }
            }
        }.start()
    }

    private fun launchInstaller(activity: Activity, apkFile: File) {
        try {
            val uri: Uri = FileProvider.getUriForFile(
                activity, activity.packageName + ".fileprovider", apkFile
            )
            val intent = Intent(Intent.ACTION_VIEW).apply {
                setDataAndType(uri, "application/vnd.android.package-archive")
                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            }
            activity.startActivity(intent)
        } catch (e: Exception) {
            android.util.Log.e("UpdateManager", "installer launch failed: ${e.message}")
            android.widget.Toast.makeText(
                activity,
                "Could not open installer: ${e.message}",
                android.widget.Toast.LENGTH_LONG
            ).show()
        }
    }
}
