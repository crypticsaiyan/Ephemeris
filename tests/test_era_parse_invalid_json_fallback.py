import era


def test_parse_returns_empty_dict_on_invalid_brace_json():
    result = era._parse("Here is the timeline: {missions: [Viking 1976]}")
    assert result == {}
