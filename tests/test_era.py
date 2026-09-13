import era


def test_parse_returns_empty_dict_on_invalid_json_in_braces():
    result = era._parse("Here is the timeline: {missions: [Viking 1976]}")
    assert result == {}
