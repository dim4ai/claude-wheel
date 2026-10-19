package expo.modules.wakeworddetector

import ai.onnxruntime.OnnxTensor
import ai.onnxruntime.OrtEnvironment
import ai.onnxruntime.OrtSession
import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import androidx.core.content.ContextCompat
import java.io.File
import java.nio.FloatBuffer

/**
 * Resnet50-ArcFace audio-embedding model from EfficientWord-Net, used as a
 * few-shot wake-word matcher: embed a 1.5s (24000 sample @16kHz) window, and
 * compare it against a handful of enrolled reference embeddings via a
 * rescaled dot product. No training needed to add a new wake word — just a
 * handful of recordings of it.
 */
class WakeWordEngine(context: Context) {
    companion object {
        const val WINDOW = 24000 // 1.5s @ 16kHz
        const val SAMPLE_RATE = 16000
        private const val ASSET_MODEL = "wakeword_model.onnx"
    }

    private val appContext = context
    private val env: OrtEnvironment = OrtEnvironment.getEnvironment()
    private val session: OrtSession
    private val inputName: String

    @Volatile private var listening = false
    private var listenThread: Thread? = null

    @Volatile private var recordingCommand = false
    private val commandBuffer = java.io.ByteArrayOutputStream()

    init {
        val modelFile = File(context.cacheDir, ASSET_MODEL)
        if (!modelFile.exists() || modelFile.length() == 0L) {
            context.assets.open(ASSET_MODEL).use { input ->
                modelFile.outputStream().use { output -> input.copyTo(output) }
            }
        }
        session = env.createSession(modelFile.absolutePath, OrtSession.SessionOptions())
        inputName = session.inputNames.iterator().next()
    }

    /** Deterministic center pad/crop to exactly WINDOW samples. */
    fun fixToWindow(x: DoubleArray): DoubleArray {
        if (x.size == WINDOW) return x
        return if (x.size > WINDOW) {
            val front = (x.size - WINDOW) / 2
            x.copyOfRange(front, front + WINDOW)
        } else {
            val out = DoubleArray(WINDOW)
            val front = (WINDOW - x.size) / 2
            System.arraycopy(x, 0, out, front, x.size)
            out
        }
    }

    /** Embed an exactly-WINDOW-length (or shorter/longer; auto-fixed) audio buffer -> 2048-dim vector. */
    fun embed(audioWindow: DoubleArray): FloatArray {
        val fixed = fixToWindow(audioWindow)
        val feat = LogFbank.computeLogfbank(fixed)
        val frames = feat.size
        val nfilt = feat[0].size
        val flat = FloatArray(frames * nfilt)
        for (t in 0 until frames) for (j in 0 until nfilt) flat[t * nfilt + j] = feat[t][j].toFloat()

        val shape = longArrayOf(1, 1, frames.toLong(), nfilt.toLong())
        OnnxTensor.createTensor(env, FloatBuffer.wrap(flat), shape).use { inputTensor ->
            session.run(mapOf(inputName to inputTensor)).use { result ->
                @Suppress("UNCHECKED_CAST")
                val out = result[0].value as Array<FloatArray>
                return out[0]
            }
        }
    }

    /** Max similarity of `inp` against a set of enrolled reference embeddings, in [0, 1]. */
    fun scoreVector(references: List<FloatArray>, inp: FloatArray): Double {
        var maxScore = -1.0
        for (ref in references) {
            var dot = 0.0
            for (i in inp.indices) dot += ref[i] * inp[i]
            val score = (dot + 1) / 2
            if (score > maxScore) maxScore = score
        }
        return maxScore
    }

    private fun checkMicPermission() {
        val granted = ContextCompat.checkSelfPermission(appContext, Manifest.permission.RECORD_AUDIO) ==
            PackageManager.PERMISSION_GRANTED
        require(granted) { "RECORD_AUDIO permission not granted" }
    }

    private fun newAudioRecord(bufferSamples: Int): AudioRecord {
        val minBuf = AudioRecord.getMinBufferSize(SAMPLE_RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT)
        return AudioRecord(
            MediaRecorder.AudioSource.MIC,
            SAMPLE_RATE,
            AudioFormat.CHANNEL_IN_MONO,
            AudioFormat.ENCODING_PCM_16BIT,
            maxOf(minBuf, bufferSamples * 2)
        )
    }

    /**
     * Finds the loudest contiguous stretch of `audio` (presumably the spoken word) by
     * walking outward from the peak-energy 20ms frame until energy drops to roughly this
     * recording's own silence floor, plus a small padding margin. Falls back to the full
     * input if nothing stands out above the floor (e.g. the mic captured only silence).
     */
    private fun trimToLoudSegment(audio: DoubleArray): DoubleArray {
        val frameLen = SAMPLE_RATE / 50 // 20ms
        val numFrames = audio.size / frameLen
        if (numFrames < 5) return audio

        val energy = DoubleArray(numFrames)
        for (f in 0 until numFrames) {
            var sum = 0.0
            val base = f * frameLen
            for (i in 0 until frameLen) sum += audio[base + i] * audio[base + i]
            energy[f] = Math.sqrt(sum / frameLen)
        }

        val floor = energy.sorted()[(numFrames * 0.2).toInt()]
        val threshold = maxOf(floor * 3.0, floor + 0.002)

        val peakIdx = energy.indices.maxByOrNull { energy[it] } ?: return audio
        if (energy[peakIdx] < threshold) return audio // nothing louder than the floor at all

        var left = peakIdx
        while (left > 0 && energy[left - 1] > threshold) left--
        var right = peakIdx
        while (right < numFrames - 1 && energy[right + 1] > threshold) right++

        val padFrames = 3 // ~60ms margin so we don't clip the word's soft onset/decay
        val startFrame = maxOf(0, left - padFrames)
        val endFrame = minOf(numFrames - 1, right + padFrames)
        val startSample = startFrame * frameLen
        val endSample = minOf(audio.size, (endFrame + 1) * frameLen)
        if (endSample - startSample < frameLen * 3) return audio // degenerate, bail out
        return audio.copyOfRange(startSample, endSample)
    }

    /** Records `durationMs` of mic audio, trims it down to just the loud (spoken) part,
     * and returns its embedding (for enrollment). */
    fun recordAndEmbed(durationMs: Int): FloatArray {
        checkMicPermission()
        val numSamples = SAMPLE_RATE * durationMs / 1000
        val recorder = newAudioRecord(numSamples)
        val shorts = ShortArray(numSamples)
        try {
            recorder.startRecording()
            var offset = 0
            while (offset < numSamples) {
                val n = recorder.read(shorts, offset, numSamples - offset)
                if (n <= 0) break
                offset += n
            }
        } finally {
            recorder.stop()
            recorder.release()
        }
        val doubleAudio = DoubleArray(numSamples) { shorts[it] / 32768.0 }
        return embed(trimToLoudSegment(doubleAudio))
    }

    /**
     * Starts a background thread that continuously records mic audio and, every `hopMs`,
     * re-scores the trailing WINDOW-sample buffer against `references`, invoking `onScore`
     * with the raw similarity (caller decides the detection threshold).
     */
    fun startListening(references: List<FloatArray>, hopMs: Int, onScore: (Double) -> Unit) {
        if (listening) return
        checkMicPermission()
        listening = true
        listenThread = Thread {
            val hopSamples = maxOf(1, SAMPLE_RATE * hopMs / 1000)
            val recorder = newAudioRecord(WINDOW)
            val window = ShortArray(WINDOW)
            val chunk = ShortArray(hopSamples)
            var filled = 0
            try {
                recorder.startRecording()
                while (listening) {
                    val n = recorder.read(chunk, 0, hopSamples)
                    if (n <= 0) continue
                    if (recordingCommand) {
                        val bytes = java.nio.ByteBuffer.allocate(n * 2).order(java.nio.ByteOrder.LITTLE_ENDIAN)
                        for (i in 0 until n) bytes.putShort(chunk[i])
                        synchronized(commandBuffer) { commandBuffer.write(bytes.array()) }
                    }
                    val shiftN = minOf(n, WINDOW)
                    if (shiftN < WINDOW) System.arraycopy(window, shiftN, window, 0, WINDOW - shiftN)
                    System.arraycopy(chunk, n - shiftN, window, WINDOW - shiftN, shiftN)
                    filled = minOf(filled + n, WINDOW)
                    if (filled >= WINDOW) {
                        val doubleWindow = DoubleArray(WINDOW) { window[it] / 32768.0 }
                        val score = scoreVector(references, embed(doubleWindow))
                        onScore(score)
                    }
                }
            } finally {
                recorder.stop()
                recorder.release()
            }
        }
        listenThread?.start()
    }

    fun stopListening() {
        listening = false
        listenThread?.join(1000)
        listenThread = null
        recordingCommand = false
        synchronized(commandBuffer) { commandBuffer.reset() }
    }

    /** Starts accumulating the raw mic audio already flowing through the listening loop
     * (no second AudioRecord session) into a buffer, for the spoken command's content. */
    fun startRecordingCommand() {
        synchronized(commandBuffer) { commandBuffer.reset() }
        recordingCommand = true
    }

    /** Stops accumulating and writes the buffered command audio out as a 16kHz mono WAV. */
    fun stopRecordingCommand(outPath: String) {
        recordingCommand = false
        val bytes = synchronized(commandBuffer) {
            val b = commandBuffer.toByteArray()
            commandBuffer.reset()
            b
        }
        val shorts = ShortArray(bytes.size / 2)
        val bb = java.nio.ByteBuffer.wrap(bytes).order(java.nio.ByteOrder.LITTLE_ENDIAN)
        for (i in shorts.indices) shorts[i] = bb.short
        WavUtil.writeMono16k(outPath, shorts)
    }
}
