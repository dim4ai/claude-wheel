package expo.modules.wakeworddetector

/**
 * Faithful port of eff_word_net's logfbank/fbank/get_filterbanks, called as:
 *   compute_logfbank_features(audio, samplerate=16000, winlen=0.025, winstep=0.01,
 *                              nfilt=64, nfft=512, preemph=0.0)
 * winfunc defaults to rectangular (no window), lowfreq=0, highfreq=samplerate/2.
 *
 * Verified against the Python reference on a desktop-JVM prototype: max abs
 * diff ~2.6e-13 on log-mel features, ~3e-8 (float32 precision) on the final
 * ONNX embedding — this is a numerically exact port, not an approximation.
 */
object LogFbank {

    private fun hz2mel(hz: Double) = 2595.0 * Math.log10(1.0 + hz / 700.0)
    private fun mel2hz(mel: Double) = 700.0 * (Math.pow(10.0, mel / 2595.0) - 1.0)

    /** nfilt x (nfft/2+1) triangular mel filterbank matrix. */
    private fun getFilterbanks(nfilt: Int, nfft: Int, samplerate: Int, lowfreq: Double, highfreq: Double): Array<DoubleArray> {
        val lowmel = hz2mel(lowfreq)
        val highmel = hz2mel(highfreq)
        val melpoints = DoubleArray(nfilt + 2) { i -> lowmel + i * (highmel - lowmel) / (nfilt + 1) }
        val bin = IntArray(nfilt + 2) { i -> Math.floor((nfft + 1) * mel2hz(melpoints[i]) / samplerate).toInt() }
        val nBins = nfft / 2 + 1
        val fbank = Array(nfilt) { DoubleArray(nBins) }
        for (j in 0 until nfilt) {
            for (i in bin[j] until bin[j + 1]) {
                if (i in 0 until nBins) fbank[j][i] = (i - bin[j]).toDouble() / (bin[j + 1] - bin[j])
            }
            for (i in bin[j + 1] until bin[j + 2]) {
                if (i in 0 until nBins) fbank[j][i] = (bin[j + 2] - i).toDouble() / (bin[j + 2] - bin[j + 1])
            }
        }
        return fbank
    }

    /** Frame a signal into overlapping frames; frames shorter than frameLen are zero-padded. */
    private fun framesig(signal: DoubleArray, frameLen: Int, frameStep: Int): Array<DoubleArray> {
        val slen = signal.size
        val numframes = if (slen <= frameLen) 1 else 1 + Math.ceil((slen - frameLen) / frameStep.toDouble()).toInt()
        val padlen = (numframes - 1) * frameStep + frameLen
        val padded = DoubleArray(padlen)
        System.arraycopy(signal, 0, padded, 0, slen)
        return Array(numframes) { i -> padded.copyOfRange(i * frameStep, i * frameStep + frameLen) }
    }

    /** Power spectrum: (1/NFFT) * |rfft(frame, NFFT)|^2, returned as nfft/2+1 bins. */
    private fun powspec(frame: DoubleArray, nfft: Int): DoubleArray {
        val re = DoubleArray(nfft)
        System.arraycopy(frame, 0, re, 0, Math.min(frame.size, nfft))
        val im = DoubleArray(nfft)
        FFT.fft(re, im)
        val nBins = nfft / 2 + 1
        return DoubleArray(nBins) { i -> (re[i] * re[i] + im[i] * im[i]) / nfft }
    }

    private fun preemphasis(signal: DoubleArray, coeff: Double): DoubleArray {
        if (coeff == 0.0) return signal
        val out = DoubleArray(signal.size)
        out[0] = signal[0]
        for (i in 1 until signal.size) out[i] = signal[i] - coeff * signal[i - 1]
        return out
    }

    private const val LOG_FLOOR = 2.220446049250313e-16 // np.finfo(float).eps

    /** Returns log mel-filterbank energies, shape [numFrames][nfilt]. */
    fun computeLogfbank(
        audio: DoubleArray,
        samplerate: Int = 16000,
        winlen: Double = 0.025,
        winstep: Double = 0.01,
        nfilt: Int = 64,
        nfft: Int = 512,
        lowfreq: Double = 0.0,
        highfreq: Double = -1.0,
        preemph: Double = 0.0,
    ): Array<DoubleArray> {
        val hf = if (highfreq > 0) highfreq else samplerate / 2.0
        val sig = preemphasis(audio, preemph)
        val frameLen = Math.round(winlen * samplerate).toInt()
        val frameStep = Math.round(winstep * samplerate).toInt()
        val frames = framesig(sig, frameLen, frameStep)
        val fbankMat = getFilterbanks(nfilt, nfft, samplerate, lowfreq, hf)
        return Array(frames.size) { t ->
            val ps = powspec(frames[t], nfft)
            DoubleArray(nfilt) { j ->
                var energy = 0.0
                for (i in ps.indices) energy += fbankMat[j][i] * ps[i]
                if (energy == 0.0) energy = LOG_FLOOR
                Math.log(energy)
            }
        }
    }
}
