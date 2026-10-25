"""Cognito rejects managed-login logos outside a 1:1 to 4:1 width:height ratio, but only at apply time."""
import re
from pathlib import Path

BRANDING = Path(__file__).resolve().parents[1] / "terraform" / "modules" / "homecloud" / "branding"


def _size(svg: Path) -> tuple[float, float]:
    head = re.search(r"<svg[^>]*>", svg.read_text()).group(0)
    return float(re.search(r'width="([\d.]+)"', head).group(1)), float(re.search(r'height="([\d.]+)"', head).group(1))


def test_logos_fit_cognito_ratio():
    for name in ("logo-light.svg", "logo-dark.svg"):
        w, h = _size(BRANDING / name)
        assert 1 <= w / h <= 4, f"{name} is {w}x{h}; Cognito needs 1:1 to 4:1"


def test_favicon_is_square():
    w, h = _size(BRANDING / "favicon.svg")
    assert w == h


def test_color_scheme_is_a_verified_value():
    # CreateManagedLoginBranding rejected "AUTO" at apply time; LIGHT and DARK are what the provider's tests use.
    tf = (BRANDING.parent / "cognito.tf").read_text()
    assert re.search(r'colorSchemeMode\s*=\s*"(LIGHT|DARK)"', tf)
