from app.services.hangul import romanize


def test_open_and_closed_syllables():
    assert romanize("가") == "ga"
    assert romanize("밤") == "bam"
    assert romanize("빛") == "bit"


def test_tense_initials_and_compound_vowels():
    assert romanize("짜") == "jja"
    assert romanize("뭐") == "mwo"
    assert romanize("의") == "ui"


def test_liaison_moves_final_onto_silent_initial():
    assert romanize("있어") == "isseo"
    assert romanize("먹어") == "meogeo"
    assert romanize("읽어") == "ilgeo"  # double final: second part moves
    assert romanize("좋아") == "joa"  # ㅎ is dropped


def test_no_liaison_across_space_or_onto_consonant():
    assert romanize("밤 이") == "bam i"
    assert romanize("밤길") == "bamgil"


def test_ng_final_stays():
    assert romanize("강아") == "ganga"


def test_non_hangul_kept():
    assert romanize("hey, 너야!") == "hey, neoya!"
    assert romanize("") == ""
