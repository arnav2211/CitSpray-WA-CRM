"""Spelling check for COAs (same idea as the OMS item-name checker).

A word is flagged when it is one or two letters off a known COA / oil word (or off a
word used far more often across the library), plus a list of known COA typos that
are real English words elsewhere ("compiles" for "complies", "optional rotation").
It only suggests; the COA maker shows "did you mean" and fixes on a click."""
from __future__ import annotations

import re
from collections import Counter
from typing import Dict, List, Optional, Tuple

CORE = set("""
certificate analysis common name latin botanical batch number no qty quantity date manufacturing mfg expiry exp best before
shelf life years year months month specification specifications result results parameter parameters test tests method
observation remarks remark note storage keep tightly closed container dry cool place protected light sunlight heat
appearance colour color odour odor characteristic solubility soluble insoluble miscible alcohol ethanol water oil oils
fixed fatty refractive index specific gravity density optical rotation acid value peroxide iodine saponification ester
moisture content purity assay ash residue flash point boiling melting freezing congealing viscosity ph clear solution
complies conforms absent present nil detected positive negative limit maximum minimum max min nmt nlt ppm cfu total plate count
yeast mold mould coliform coli salmonella staphylococcus aureus pseudomonas aeruginosa microbiological physical chemical
physico heavy metals lead arsenic mercury cadmium profile composition chromatography gas liquid yellow pale golden brown red
green orange colourless colorless transparent viscous mobile liquid solid crystals crystalline flakes powder semi
characteristic fresh lemony woody sweet floral spicy minty herbal earthy citrus fruity balsamic camphoraceous musky smoky
extraction distillation steam cold pressed expressed solvent hexane extracted part used leaves leaf flowers flower seeds seed
bark roots root wood resin peel fruit kernel nut beans bean grass needles twigs whole plant country origin india indian
department quality control qc authorised authorized signatory signature buyer customer product products grade natural pure
essential carrier absolute hydrosol extract butter juice oleoresin oleoresins wax blend linalool linalyl acetate geraniol
citral citronellal citronellol limonene pinene cineole eucalyptol menthol menthone camphor borneol isoborneol eugenol
cinnamaldehyde thymol carvacrol vanillin santalol vetiverol patchoulol nerol neral geranial terpinene terpineol terpene
terpenes alcohols aldehydes ketones phenols oleic linoleic linolenic palmitic stearic myristic lauric capric caprylic
behenic arachidic erucic gondoic eicosenoic palmitoleic tocopherol tocopherols vitamin glyceride glycerides triglycerides
lavender rosemary peppermint spearmint eucalyptus citronella lemongrass jasmine sandalwood bergamot cedarwood cedar cinnamon
clove geranium patchouli vetiver frankincense myrrh ylang chamomile cypress juniper palmarosa marjoram oregano thyme basil
tulsi ginger turmeric fennel cardamom nutmeg pepper wintergreen mint lemon orange grapefruit lime mandarin tangerine neroli
rose rosa damascena mogra champa khus kewda saffron oud agarwood musk amber vanilla coffee arabica roasted cucumber coconut
almond bitter jojoba argan avocado castor sesame mustard olive sunflower apricot rosehip flaxseed neem tea tree aloe vera
glycerin fractionated mct shea mahua chaulmoogra tamanu catnip fenugreek garlic capsicum dipentene turpentine pine
borneol citriodora sea buckthorn oats kashmiri piperita flexuosus cymbopogon lavandula angustifolia rosmarinus officinalis
mentha arvensis azadirachta indica simmondsia chinensis argania spinosa ricinus communis prunus dulcis amygdalus cocos
nucifera butyrospermum parkii madhuca longifolia calophyllum inophyllum nepeta cataria trigonella foenum graecum allium
sativum capsicum annuum pinus cedrus deodara pogostemon cablin vetiveria zizanioides jasminum grandiflorum cinnamomum
zeylanicum verum citrus limon sinensis aurantium hippophae rhamnoides avena sativa barbadensis gaultheria procumbens
melaleuca alternifolia santalum album aquilaria agallocha cucumis sativus coffea camphora
relative comments comment analysts analyst specified cinnamic aldehyde aldehydes ketone phenol metal smokey azadirachtin
mg kg ml gm gms g l ltr litre liter ltrs cm mm °c at to and or of in with from by for the a an is not as per on be
""".split())

# Known COA typos that are real words elsewhere (the distance check would not catch them).
KNOWN_FIXES = {
    "compiles": "complies", "comman": "common", "commen": "common", "anaysis": "analysis", "analysys": "analysis",
    "reflactive": "refractive", "refrective": "refractive", "lodine": "iodine", "oieic": "oleic", "oleric": "oleic",
    "olec": "oleic", "caorylic": "caprylic", "trst": "test", "moald": "mold", "silvent": "solvent", "leavf": "leaf",
    "odout": "odour", "lnalyl": "linalyl", "saponifiaction": "saponification", "rosemery": "rosemary", "swwet": "sweet",
    "dipentence": "dipentene", "aaloevera": "aloe vera", "aloevera": "aloe vera", "jasmin": "jasmine", "coil": None,
    "spefication": "specification", "specfication": "specification", "solubilty": "solubility", "gravty": "gravity",
}
PHRASE_FIXES = {
    "optional rotation": "optical rotation", "e.coil": "e.coli", "e. coil": "e. coli", "lemon grass": "lemongrass",
    "sandal wood": "sandalwood", "cedar wood": "cedarwood", "winter green": "wintergreen", "rose mary": "rosemary",
    "pepper mint": "peppermint", "palma rosa": "palmarosa", "purity by ge": "purity by GC",
}
# real words that look like typos of commoner words: never flagged
PROTECT = {"bitter", "citral", "citronellal", "thymol", "rosa", "kernel", "neral", "nerol", "geranial", "methyl", "ethyl",
           "acetate", "flash", "nil", "semi", "per", "max", "min", "nmt", "nlt", "cfu", "ppm", "mct", "wood", "leaves"}
_VOWELS = set("aeiou")


def _dl(a: str, b: str) -> int:
    if abs(len(a) - len(b)) > 2:
        return 3
    d = [[0] * (len(b) + 1) for _ in range(len(a) + 1)]
    for i in range(len(a) + 1):
        d[i][0] = i
    for j in range(len(b) + 1):
        d[0][j] = j
    for i in range(1, len(a) + 1):
        for j in range(1, len(b) + 1):
            c = 0 if a[i - 1] == b[j - 1] else 1
            d[i][j] = min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + c)
            if i > 1 and j > 1 and a[i - 1] == b[j - 2] and a[i - 2] == b[j - 1]:
                d[i][j] = min(d[i][j], d[i - 2][j - 2] + 1)
    return d[-1][-1]


def _plausible(w: str, v: str, dist: int) -> bool:
    if len(w) <= 3:
        return dist == 1 and len(v) == 3 and sorted(w) == sorted(v) and v in CORE
    if w.startswith(v) or v.startswith(w):
        return (len(v) == len(w) + 1 and v in CORE) or (len(w) == len(v) + 1 and w[-1] == w[-2])
    if len(w) == len(v) and dist == 1 and sorted(w) != sorted(v):
        if len(w) <= 5:
            return False
        if len(w) <= 7:
            diff = [(a, b) for a, b in zip(w, v) if a != b]
            return len(diff) == 1 and diff[0][0] in _VOWELS and diff[0][1] in _VOWELS
    return True


class Speller:
    def __init__(self, library_texts: List[str]):
        self.words: Counter = Counter()
        for t in library_texts:
            for w in re.findall(r"[a-z]+", (t or "").lower()):
                self.words[w] += 1
        for w in CORE:
            self.words[w] += 50
        self.by_len: Dict[int, List[str]] = {}
        for w in self.words:
            self.by_len.setdefault(len(w), []).append(w)
        self.memo: Dict[str, Optional[str]] = {}

    def fix_word(self, w: str) -> Optional[str]:
        """Correct spelling of a lower-case word, or None if it looks fine."""
        if w in KNOWN_FIXES:
            return KNOWN_FIXES[w]
        if len(w) < 3 or w in CORE or w in PROTECT:
            return None
        if w in self.memo:
            return self.memo[w]
        n = self.words.get(w, 0)
        limit = 1 if len(w) <= 7 else 2
        best, best_score = None, 0
        for L in range(len(w) - limit, len(w) + limit + 1):
            for v in self.by_len.get(L, ()):
                if v == w or (v[:1] != w[:1] and _dl(w[:2], v[:2]) > 1):
                    continue
                core = v in CORE
                if not core and self.words[v] < max(5, 4 * n):
                    continue
                dist = _dl(w, v)
                if dist > limit or not _plausible(w, v, dist):
                    continue
                score = (100000 if core else 0) + self.words[v] - dist * 1000
                if score > best_score:
                    best, best_score = v, score
        self.memo[w] = best
        return best


def match_case(src: str, fix: str) -> str:
    if src.isupper():
        return fix.upper()
    if src[:1].isupper():
        return fix[:1].upper() + fix[1:]
    return fix


def check_text(text: str, sp: Speller) -> List[Tuple[str, str]]:
    """[(wrong, right)] in one piece of text, cased like the original."""
    out: List[Tuple[str, str]] = []
    if not text:
        return out
    low = text.lower()
    for a, b in PHRASE_FIXES.items():
        for m in re.finditer(re.escape(a), low):
            s, e = m.span()
            # whole words only
            if (s == 0 or not low[s - 1].isalpha()) and (e == len(low) or not low[e].isalpha()):
                out.append((text[s:e], match_case(text[s:e], b)))
    # whole words only - letters inside codes like "MG/CTS10SEMA" are skipped
    for m in re.finditer(r"(?<![A-Za-z0-9])[A-Za-z]+(?![A-Za-z0-9])", text):
        w = m.group(0)
        if any(w in a for a, _ in out):
            continue
        f = sp.fix_word(w.lower())
        if f and f != w.lower():
            out.append((w, match_case(w, f)))
    seen, uniq = set(), []
    for a, b in out:
        if a not in seen:
            seen.add(a)
            uniq.append((a, b))
    return uniq


def coa_texts(coa: dict):
    """(path, text) for every editable text of a COA."""
    yield ["title"], coa.get("title") or ""
    for i, r in enumerate(coa.get("info") or []):
        yield ["info", i, "label"], r.get("label") or ""
        yield ["info", i, "value"], r.get("value") or ""
    yield ["mfg_label"], coa.get("mfg_label") or ""
    yield ["exp_label"], coa.get("exp_label") or ""
    for si, s in enumerate(coa.get("sections") or []):
        yield ["sections", si, "title"], s.get("title") or ""
        for ci, c in enumerate(s.get("columns") or []):
            yield ["sections", si, "columns", ci], c or ""
        for ri, r in enumerate(s.get("rows") or []):
            for ci, c in enumerate(r):
                yield ["sections", si, "rows", ri, ci], c or ""
    if coa.get("note_mode") != "standard":
        yield ["note"], coa.get("note") or ""


def check_coa(coa: dict, sp: Speller) -> List[dict]:
    issues = []
    for path, text in coa_texts(coa):
        for wrong, right in check_text(str(text), sp):
            issues.append({"path": path, "word": wrong, "suggestion": right})
    return issues


def apply_fixes(text: str, pairs: List[Tuple[str, str]]) -> str:
    for wrong, right in pairs:
        text = re.sub(r"(?<![A-Za-z])" + re.escape(wrong) + r"(?![A-Za-z])", right, text)
    return text
