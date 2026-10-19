package expo.modules.wakeworddetector

import java.io.File
import java.nio.ByteBuffer
import java.nio.ByteOrder

/** Minimal 16-bit PCM mono/stereo WAV reader -> DoubleArray in [-1,1], mixed to mono, resampled to 16kHz if needed. */
object WavUtil {
    fun readMono16k(path: String): DoubleArray {
        val bytes = File(path).readBytes()
        val bb = ByteBuffer.wrap(bytes).order(ByteOrder.LITTLE_ENDIAN)

        bb.position(22)
        val numChannels = bb.short.toInt() and 0xFFFF
        val sampleRate = bb.int
        bb.position(34)
        val bitsPerSample = bb.short.toInt() and 0xFFFF

        bb.position(12)
        var dataOffset = -1
        var dataSize = -1
        while (bb.remaining() >= 8) {
            val idBytes = ByteArray(4)
            bb.get(idBytes)
            val id = String(idBytes, Charsets.US_ASCII)
            val size = bb.int
            if (id == "data") {
                dataOffset = bb.position()
                dataSize = size
                break
            } else {
                bb.position(bb.position() + size + (size % 2))
            }
        }
        require(dataOffset >= 0) { "no data chunk found in $path" }
        require(bitsPerSample == 16) { "expected 16-bit PCM, got $bitsPerSample" }

        val numSamples = dataSize / 2 / numChannels
        val mono = DoubleArray(numSamples)
        bb.position(dataOffset)
        for (i in 0 until numSamples) {
            var sum = 0.0
            for (c in 0 until numChannels) sum += bb.short / 32768.0
            mono[i] = sum / numChannels
        }
        return if (sampleRate == 16000) mono else resample(mono, sampleRate, 16000)
    }

    private fun resample(audio: DoubleArray, fromRate: Int, toRate: Int): DoubleArray {
        val newLength = (audio.size.toLong() * toRate / fromRate).toInt()
        val out = DoubleArray(newLength)
        for (i in 0 until newLength) {
            val srcPos = i.toDouble() * fromRate / toRate
            val idx = srcPos.toInt()
            val frac = srcPos - idx
            val a = audio.getOrElse(idx) { audio.last() }
            val b = audio.getOrElse(idx + 1) { audio.last() }
            out[i] = a + (b - a) * frac
        }
        return out
    }
}
