"""Artifact scoring for synthesised speech (no reference needed).

The diffusion sampler draws fresh noise each run, so glitches are stochastic:
generating a chunk again usually yields a clean take.  This module scores a
take so the server can pick the best of several.  The score is a weighted sum
of three proxies, all per second of audio:

- bursts:   isolated 10 ms frames whose >5 kHz energy share spikes far above the
            local median (crackle / clicks that are not fricatives),
- clicks:   sample-to-sample jumps larger than 0.12 full scale,
- dropouts: sub-100 ms holes of near-silence inside speech.
"""
from __future__ import annotations

from dataclasses import dataclass, asdict

import numpy as np


@dataclass
class QualityScore:
    score: float
    bursts_per_s: float
    clicks_per_s: float
    dropouts_per_s: float
    peak: float
    seconds: float

    def to_dict(self) -> dict:
        return {k: (round(v, 3) if isinstance(v, float) else v) for k, v in asdict(self).items()}


def score_pcm16(pcm: bytes, sample_rate: int) -> QualityScore:
    x = np.frombuffer(pcm, dtype=np.int16).astype(np.float32) / 32768.0
    seconds = max(1e-6, len(x) / sample_rate)
    if len(x) < sample_rate // 4:
        return QualityScore(0.0, 0.0, 0.0, 0.0, float(np.abs(x).max()) if len(x) else 0.0, seconds)

    hop = int(sample_rate * 0.01)
    n = len(x) // hop
    frames = x[: n * hop].reshape(n, hop) * np.hanning(hop)
    spec = np.abs(np.fft.rfft(frames, axis=1)) ** 2
    freqs = np.fft.rfftfreq(hop, 1 / sample_rate)
    energy = spec.sum(axis=1) + 1e-12
    hf = spec[:, freqs > 5000].sum(axis=1) / energy
    speech = energy > np.percentile(energy, 30)

    # isolated high-frequency bursts
    bursts = 0
    for i in range(1, n - 1):
        lo, hi = max(0, i - 15), min(n, i + 16)
        med = float(np.median(hf[lo:hi])) + 1e-4
        if speech[i] and hf[i] > 4 * med and hf[i - 1] < 2 * med and hf[i + 1] < 2 * med:
            bursts += 1

    # sharp transients
    clicks = int((np.abs(np.diff(x)) > 0.12).sum())

    # short dropouts inside speech: frames far below the running level, flanked by speech
    level = np.sqrt(energy / hop)
    med_level = float(np.median(level[speech])) if speech.any() else 0.0
    dropouts = 0
    i = 1
    while i < n - 1 and med_level > 0:
        if level[i] < med_level * 0.05 and level[i - 1] > med_level * 0.3:
            j = i
            while j < n and level[j] < med_level * 0.05:
                j += 1
            if 1 <= j - i <= 10 and j < n and level[j] > med_level * 0.3:  # 10–100 ms hole
                dropouts += 1
            i = j
        else:
            i += 1

    b, c, d = bursts / seconds, clicks / seconds, dropouts / seconds
    score = 3.0 * b + 0.15 * c + 2.0 * d
    return QualityScore(float(score), float(b), float(c), float(d), float(np.abs(x).max()), seconds)
