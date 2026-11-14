// AudioWorklet 处理器：把麦克风浮点采样转成 16bit PCM
// 采样率转换由浏览器在建立 AudioContext 时完成（sampleRate: 16000），
// 所以这里只需要把 Float32 → Int16。
class PCMProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.recording = true;
    this.port.onmessage = (e) => {
      if (e.data === "stop") this.recording = false;
    };
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0) return true;
    const channel = input[0];
    if (!channel || channel.length === 0) return true;

    // Float32 [-1, 1] → Int16
    const pcm = new Int16Array(channel.length);
    for (let i = 0; i < channel.length; i++) {
      const s = Math.max(-1, Math.min(1, channel[i]));
      pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }

    if (this.recording) {
      // 转移所有权，避免拷贝
      this.port.postMessage(pcm.buffer, [pcm.buffer]);
    }
    return true;
  }
}

registerProcessor("pcm-processor", PCMProcessor);