# Third-party notices for the speech models

Gram ships no speech model. Settings → Voice input downloads these from Hugging Face, each at a
pinned revision with every file's size and sha256 checked, and only after the user agrees to the
model's licence on a screen that names it. `manifest.ts` pins them. Each installed model's folder
also gets a `NOTICE` file holding its attribution.

## Nemotron Speech Streaming EN 0.6B

Live text while you speak, in every mode.

Licensed by NVIDIA Corporation under the NVIDIA Open Model License.
https://www.nvidia.com/en-us/agreements/enterprise-software/nvidia-open-model-license/

Source: https://huggingface.co/nvidia/nemotron-speech-streaming-en-0.6b, exported to int8 ONNX by
the sherpa-onnx project (https://huggingface.co/csukuangfj2).

## Parakeet TDT 0.6B v2

The Accurate mode's second pass.

Parakeet TDT 0.6B v2 by NVIDIA, licensed under CC BY 4.0; converted to int8 ONNX by the sherpa-onnx project.
License: Creative Commons Attribution 4.0 International, https://creativecommons.org/licenses/by/4.0/

Source: https://huggingface.co/nvidia/parakeet-tdt-0.6b-v2. Gram uses the int8 ONNX export at
https://huggingface.co/csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8, which quantises the
weights and changes nothing else; Gram changes nothing further.

## Silero VAD v5

Trims the silence off each utterance in Accurate mode, and skips an utterance with no speech in it.

Silero VAD, copyright (c) 2020-present Silero Team, licensed under the MIT License.
License: https://github.com/snakers4/silero-vad/blob/v5.0/LICENSE
Source: https://github.com/snakers4/silero-vad, `files/silero_vad.onnx` at tag v5.0.

```text
MIT License

Copyright (c) 2020-present Silero Team

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
