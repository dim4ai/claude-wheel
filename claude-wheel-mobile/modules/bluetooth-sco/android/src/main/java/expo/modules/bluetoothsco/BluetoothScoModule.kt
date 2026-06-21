package expo.modules.bluetoothsco

import android.content.Context
import android.media.AudioManager
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class BluetoothScoModule : Module() {
  private val audioManager: AudioManager?
    get() = appContext.reactContext?.getSystemService(Context.AUDIO_SERVICE) as? AudioManager

  override fun definition() = ModuleDefinition {
    Name("BluetoothSco")

    Function("start") {
      audioManager?.let {
        it.mode = AudioManager.MODE_IN_COMMUNICATION
        it.startBluetoothSco()
        it.isBluetoothScoOn = true
      }
    }

    Function("stop") {
      audioManager?.let {
        it.stopBluetoothSco()
        it.isBluetoothScoOn = false
        it.mode = AudioManager.MODE_NORMAL
      }
    }
  }
}
