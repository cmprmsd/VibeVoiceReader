"""Voice preset discovery and metadata parsed from the preset file names.

Preset files look like ``en-Carter_man.pt`` or
``experimental_voices/de/de-Spk2_woman.pt``.
"""
from __future__ import annotations

import os
import re
from dataclasses import dataclass, asdict
from pathlib import Path
from typing import Dict, List, Optional

_NAME_RE = re.compile(r"^(?P<code>[a-z]{2})-(?P<name>[^_]+)_(?P<gender>man|woman)$")

# file prefix -> (BCP-47 language tag, label)
LANGUAGES = {
    "en": ("en", "English"),
    "in": ("en-IN", "English (India)"),
    "de": ("de", "German"),
    "fr": ("fr", "French"),
    "it": ("it", "Italian"),
    "jp": ("ja", "Japanese"),
    "kr": ("ko", "Korean"),
    "nl": ("nl", "Dutch"),
    "pl": ("pl", "Polish"),
    "pt": ("pt", "Portuguese"),
    "sp": ("es", "Spanish"),
}

PREVIEW_SENTENCES = {
    "en": "Hi, this is a quick preview of my voice. I can read articles, documents, and anything you select.",
    "de": "Hallo, das ist eine kurze Vorschau meiner Stimme. Ich lese Artikel und markierten Text vor.",
    "fr": "Bonjour, voici un court aperçu de ma voix. Je peux lire des articles et le texte sélectionné.",
    "it": "Ciao, questa è una breve anteprima della mia voce. Posso leggere articoli e testo selezionato.",
    "ja": "こんにちは。これは私の声の短いプレビューです。記事や選択したテキストを読み上げます。",
    "ko": "안녕하세요. 제 목소리의 짧은 미리보기입니다. 기사와 선택한 텍스트를 읽어 드립니다.",
    "nl": "Hallo, dit is een korte preview van mijn stem. Ik kan artikelen en geselecteerde tekst voorlezen.",
    "pl": "Cześć, to krótka zapowiedź mojego głosu. Mogę czytać artykuły i zaznaczony tekst.",
    "pt": "Olá, esta é uma breve prévia da minha voz. Posso ler artigos e o texto selecionado.",
    "es": "Hola, esta es una breve vista previa de mi voz. Puedo leer artículos y el texto seleccionado.",
}


@dataclass(frozen=True)
class VoiceInfo:
    id: str
    name: str
    lang: str
    lang_label: str
    gender: str
    experimental: bool
    path: Path

    def preview_text(self) -> str:
        base = self.lang.split("-")[0]
        return PREVIEW_SENTENCES.get(base, PREVIEW_SENTENCES["en"])

    def to_public(self) -> dict:
        d = asdict(self)
        d.pop("path")
        d["preview"] = f"/preview/{self.id}"
        return d


def parse_voice(pt_path: Path) -> VoiceInfo:
    stem = pt_path.stem
    experimental = any("experimental" in p.lower() for p in pt_path.parts)
    m = _NAME_RE.match(stem)
    if not m:
        return VoiceInfo(stem, stem, "en", "English", "unknown", experimental, pt_path)
    code = m.group("code")
    lang, label = LANGUAGES.get(code, (code, code.upper()))
    name = m.group("name")
    if name.startswith("Spk") and name[3:].isdigit():
        name = f"{label} speaker {name[3:]}"
    return VoiceInfo(stem, name, lang, label, m.group("gender"), experimental, pt_path)


def discover_voices(voices_dir: Path) -> Dict[str, VoiceInfo]:
    if not voices_dir.is_dir():
        raise RuntimeError(f"Voices directory not found: {voices_dir}")
    voices: List[VoiceInfo] = [parse_voice(p) for p in voices_dir.rglob("*.pt")]
    if not voices:
        raise RuntimeError(f"No voice presets (*.pt) under {voices_dir}")
    # Order: English, English (India), German, then other languages alphabetically;
    # within a language the production voices first, experimental right behind.
    priority = {"en": 0, "en-IN": 1, "de": 2}
    voices.sort(key=lambda v: (priority.get(v.lang, 3), v.lang, v.experimental, v.name))
    return {v.id: v for v in voices}


def split_dirs(value) -> List[Path]:
    """A PATH-like list of directories ("a:b") -> existing Paths, in order."""
    if not value:
        return []
    out: List[Path] = []
    for part in str(value).split(os.pathsep):
        part = part.strip()
        if part:
            out.append(Path(part).expanduser())
    return out


def dirs_signature(dirs: List[Path]) -> tuple:
    """Changes whenever a clip is added, removed or replaced in any of the folders."""
    sig = []
    for d in dirs:
        if d.is_dir():
            for p in sorted(d.rglob("*.wav")):
                try:
                    sig.append((str(p), p.stat().st_mtime_ns))
                except OSError:
                    pass
    return tuple(sig)


def clip_voices(dirs: List[Path], extra: Optional[List[VoiceInfo]] = None) -> List[VoiceInfo]:
    """Reference clips as voices, named like the presets: xx-Name_gender.wav.  Later folders win on equal ids."""
    found: Dict[str, VoiceInfo] = {v.id: v for v in (extra or [])}
    for d in dirs:
        if not d.is_dir():
            continue
        for p in sorted(d.rglob("*.wav")):
            stem = p.stem
            parts = stem.split("-", 1)
            code = parts[0] if len(parts) == 2 and len(parts[0]) == 2 else "en"
            lang, label = LANGUAGES.get(code, (code, code.upper()))
            name = (parts[1] if len(parts) == 2 else stem).split("_")[0]
            gender = "woman" if stem.endswith("_woman") else "man" if stem.endswith("_man") else "unknown"
            found[stem] = VoiceInfo(stem, name, lang, label, gender, "experimental" in stem.lower(), p)
    priority = {"en": 0, "en-IN": 1, "de": 2}
    ordered = sorted(found.values(), key=lambda v: (v.path == Path(), priority.get(v.lang, 3), v.lang, v.experimental, v.name))
    return ordered
