package expo.modules.wakeworddetector

import ai.onnxruntime.OnnxTensor
import ai.onnxruntime.OrtEnvironment
import ai.onnxruntime.OrtSession
import android.content.Context
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
        private const val ASSET_MODEL = "wakeword_model.onnx"
    }

    private val env: OrtEnvironment = OrtEnvironment.getEnvironment()
    private val session: OrtSession
    private val inputName: String

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
}
