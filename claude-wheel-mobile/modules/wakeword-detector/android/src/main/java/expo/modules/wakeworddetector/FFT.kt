package expo.modules.wakeworddetector

/** In-place iterative radix-2 Cooley-Tukey FFT. n must be a power of 2.
 * Ported from a desktop-JVM prototype that was numerically verified (max abs
 * diff ~1e-13) against eff_word_net's Python log-mel-filterbank pipeline. */
object FFT {
    fun fft(re: DoubleArray, im: DoubleArray) {
        val n = re.size
        require(n == im.size) { "length mismatch" }
        require(n and (n - 1) == 0) { "n must be power of 2, got $n" }

        val bits = Integer.numberOfTrailingZeros(n)
        for (i in 0 until n) {
            val j = Integer.reverse(i) ushr (32 - bits)
            if (j > i) {
                val tr = re[i]; re[i] = re[j]; re[j] = tr
                val ti = im[i]; im[i] = im[j]; im[j] = ti
            }
        }

        var len = 2
        while (len <= n) {
            val ang = -2 * Math.PI / len
            val wRe = Math.cos(ang)
            val wIm = Math.sin(ang)
            var i = 0
            while (i < n) {
                var curRe = 1.0
                var curIm = 0.0
                for (j in 0 until len / 2) {
                    val uRe = re[i + j]
                    val uIm = im[i + j]
                    val vRe = re[i + j + len / 2] * curRe - im[i + j + len / 2] * curIm
                    val vIm = re[i + j + len / 2] * curIm + im[i + j + len / 2] * curRe
                    re[i + j] = uRe + vRe
                    im[i + j] = uIm + vIm
                    re[i + j + len / 2] = uRe - vRe
                    im[i + j + len / 2] = uIm - vIm
                    val nextRe = curRe * wRe - curIm * wIm
                    val nextIm = curRe * wIm + curIm * wRe
                    curRe = nextRe
                    curIm = nextIm
                }
                i += len
            }
            len = len shl 1
        }
    }
}
