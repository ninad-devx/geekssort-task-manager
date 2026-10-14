"""Everyone can dress up their own profile; nobody can escalate through it."""

from __future__ import annotations

from tests.conftest import CSRF, login


def test_member_can_set_their_own_display_name_and_picture(client, users):
    login(client, "m1@x.com")
    r = client.patch(
        f"/api/users/{users['m1']}",
        headers=CSRF,
        json={"display_name": "Mia", "avatar_url": "https://example.com/mia.png"},
    )
    assert r.status_code == 200, r.text
    assert r.json()["display_name"] == "Mia"
    assert r.json()["avatar_url"] == "https://example.com/mia.png"


def test_profile_edit_never_changes_authority(client, users):
    login(client, "m1@x.com")
    r = client.patch(
        f"/api/users/{users['m1']}",
        headers=CSRF,
        json={"display_name": "Mia", "is_admin": True},
    )
    # Mixed payload is no longer "profile only", so it hits the admin gate.
    assert r.status_code == 403
    assert r.json()["detail"]["code"] == "ADMIN_ONLY"


def test_member_cannot_edit_another_persons_profile(client, users):
    login(client, "m1@x.com")
    r = client.patch(
        f"/api/users/{users['m2']}",
        headers=CSRF,
        json={"display_name": "Hacked"},
    )
    assert r.status_code == 403


def test_cannot_change_own_role_via_the_profile_endpoint(client, users):
    login(client, "m1@x.com")
    r = client.patch(
        f"/api/users/{users['m1']}",
        headers=CSRF,
        json={"role": "ceo"},
    )
    assert r.status_code == 403


def test_unsafe_avatar_url_is_rejected(client, users):
    login(client, "m1@x.com")
    r = client.patch(
        f"/api/users/{users['m1']}",
        headers=CSRF,
        json={"avatar_url": "javascript:alert(1)"},
    )
    assert r.status_code == 422
    assert r.json()["detail"]["code"] == "INVALID_AVATAR_URL"


def test_bad_avatar_colour_is_rejected(client, users):
    login(client, "m1@x.com")
    r = client.patch(
        f"/api/users/{users['m1']}",
        headers=CSRF,
        json={"avatar_color": "red"},
    )
    assert r.status_code == 422
    assert r.json()["detail"]["code"] == "INVALID_AVATAR_COLOR"


def test_admin_can_still_edit_a_persons_profile(client, users):
    login(client, "lead@x.com")
    r = client.patch(
        f"/api/users/{users['m1']}",
        headers=CSRF,
        json={"display_name": "Set by admin"},
    )
    assert r.status_code == 200
    assert r.json()["display_name"] == "Set by admin"


def test_profile_survives_a_session_refresh(client, users):
    login(client, "m1@x.com")
    client.patch(f"/api/users/{users['m1']}", headers=CSRF, json={"display_name": "Mia"})
    login(client, "m1@x.com")
    assert client.get("/api/auth/me").json()["user"]["display_name"] == "Mia"


def test_directory_exposes_the_profile_for_assignment_pickers(client, users):
    login(client, "m1@x.com")
    client.patch(
        f"/api/users/{users['m1']}",
        headers=CSRF,
        json={"display_name": "Mia", "avatar_url": "https://example.com/mia.png"},
    )
    directory = client.get("/api/users/directory").json()
    entry = next(d for d in directory if d["id"] == users["m1"])
    assert entry["display_name"] == "Mia"
    assert entry["avatar_url"] == "https://example.com/mia.png"


def test_an_explicit_null_clears_the_display_name(client, users):
    login(client, "m1@x.com")
    client.patch(f"/api/users/{users['m1']}", headers=CSRF, json={"display_name": "Mia"})
    r = client.patch(f"/api/users/{users['m1']}", headers=CSRF, json={"display_name": None})
    assert r.status_code == 200
    assert r.json()["display_name"] is None


def test_an_omitted_field_is_left_alone(client, users):
    login(client, "m1@x.com")
    client.patch(
        f"/api/users/{users['m1']}",
        headers=CSRF,
        json={"display_name": "Mia", "avatar_color": "#123456"},
    )
    # Only the colour is mentioned; the name must survive.
    r = client.patch(f"/api/users/{users['m1']}", headers=CSRF, json={"avatar_color": "#654321"})
    assert r.json()["display_name"] == "Mia"
    assert r.json()["avatar_color"] == "#654321"


def test_an_explicit_null_clears_the_avatar(client, users):
    login(client, "m1@x.com")
    client.patch(
        f"/api/users/{users['m1']}",
        headers=CSRF,
        json={"avatar_url": "https://example.com/mia.png"},
    )
    r = client.patch(f"/api/users/{users['m1']}", headers=CSRF, json={"avatar_url": None})
    assert r.json()["avatar_url"] is None