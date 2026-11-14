// AudioWorklet 处理器：把麦克风浮点采样转成 16bit PCM
//
// 关键：AudioWorklet 每 128 个采样回调一次（约 8ms），单次只有 256 字节。
// 如果每次都直接 postMessage，会变成每秒 125 个 256 字节的碎片，
// 实时识别服务（DashScope）拿不到有效音频块，表现为「录音中但识别不出任何文字」。
//
// 所以这里做缓冲累积：攒够约 100ms（1600 采样 = 3200 字节）再发一次。
// 实测修复前单帧 256 字节，修复后 3200 字节。

const CHUNK_SAMPLES = 1600; // 100ms @ 16kHz

class PCMProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.recording = true;
    this.buffer = new Int16Array(CHUNK_SAMPLES);
    this.offset = 0;

    this.port.onmessage = (e) => {
      if (e.data === "stop") {
        this.recording = false;
        this.flush();
      }
    };
  }

  flush() {
    if (this.offset > 0) {
      // 只发真正采集到的部分，避免补零尾巴
      const out = this.buffer.slice(0, this.offset);
      this.port.postMessage(out.buffer, [out.buffer]);
      this.buffer = new Int16Array(CHUNK_SAMPLES);
      this.offset = 0;
    }
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0) return true;
    const channel = input[0];
    if (!channel || channel.length === 0) return true;

    for (let i = 0; i < channel.length; i++) {
      const s = Math.max(-1, Math.min(1, channel[i]));
      this.buffer[this.offset++] = s < 0 ? s * 0x8000 : s * 0x7fff;

      if (this.offset >= CHUNK_SAMPLES) {
        if (this.recording) this.flush();
        else this.offset = 0;
      }
    }
    return true;
  }
}

registerProcessor("pcm-processor", PCMProcessor);