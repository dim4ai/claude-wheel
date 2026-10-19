package expo.modules.wakeworddetector

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class WakeWordDetectorModule : Module() {
    private val engine: WakeWordEngine by lazy {
        WakeWordEngine(appContext.reactContext!!.applicationContext)
    }

    override fun definition() = ModuleDefinition {
        Name("WakeWordDetector")

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
    }
}
