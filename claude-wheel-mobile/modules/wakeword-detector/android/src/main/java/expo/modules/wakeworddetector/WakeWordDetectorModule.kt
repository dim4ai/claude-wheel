package expo.modules.wakeworddetector

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.File

class WakeWordDetectorModule : Module() {
    private val engine: WakeWordEngine by lazy {
        WakeWordEngine(appContext.reactContext!!.applicationContext)
    }

    override fun definition() = ModuleDefinition {
        Name("WakeWordDetector")

        Events("onScore")

        AsyncFunction("embedFile") { path: String ->
            val audio = WavUtil.readMono16k(path)
            engine.embed(audio).map { it.toDouble() }
        }

        AsyncFunction("scoreFile") { path: String, references: List<List<Double>> ->
            val audio = WavUtil.readMono16k(path)
            val emb = engine.embed(audio)
            val refArrays = references.map { ref -> FloatArray(ref.size) { i -> ref[i].toFloat() } }
            engine.scoreVector(refArrays, emb)
        }

        AsyncFunction("recordSample") { durationMs: Int ->
            engine.recordAndEmbed(durationMs).map { it.toDouble() }
        }

        AsyncFunction("startListening") { references: List<List<Double>>, hopMs: Int ->
            val refArrays = references.map { ref -> FloatArray(ref.size) { i -> ref[i].toFloat() } }
            engine.startListening(refArrays, hopMs) { score ->
                sendEvent("onScore", mapOf("score" to score))
            }
        }

        AsyncFunction("stopListening") {
            engine.stopListening()
        }

        AsyncFunction("startRecordingCommand") {
            engine.startRecordingCommand()
        }

        AsyncFunction("stopRecordingCommand") {
            val cacheDir = appContext.reactContext!!.applicationContext.cacheDir
            val outFile = File(cacheDir, "ww_command_${System.currentTimeMillis()}.wav")
            engine.stopRecordingCommand(outFile.absolutePath)
            "file://${outFile.absolutePath}"
        }
    }
}
