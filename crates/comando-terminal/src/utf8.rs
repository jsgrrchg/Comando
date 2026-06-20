/// Incrementally decodes PTY bytes as UTF-8 while carrying incomplete trailing
/// multi-byte sequences across reads. Invalid bytes are replaced with U+FFFD.
#[derive(Debug, Default)]
pub struct Utf8CarryDecoder {
    carry: Vec<u8>,
}

impl Utf8CarryDecoder {
    pub fn decode(&mut self, bytes: &[u8]) -> String {
        decode_utf8_with_carry(&mut self.carry, bytes)
    }
}

pub fn decode_utf8_with_carry(carry: &mut Vec<u8>, bytes: &[u8]) -> String {
    carry.extend_from_slice(bytes);
    let mut output = String::new();
    let mut start = 0;

    loop {
        match std::str::from_utf8(&carry[start..]) {
            Ok(valid) => {
                output.push_str(valid);
                carry.clear();
                return output;
            }
            Err(error) => {
                let valid_up_to = error.valid_up_to();
                // SAFETY: valid_up_to is guaranteed to be a valid UTF-8 boundary.
                output.push_str(unsafe {
                    std::str::from_utf8_unchecked(&carry[start..start + valid_up_to])
                });

                match error.error_len() {
                    Some(invalid_len) => {
                        output.push('\u{FFFD}');
                        start += valid_up_to + invalid_len;
                    }
                    None => {
                        *carry = carry[start + valid_up_to..].to_vec();
                        return output;
                    }
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decodes_split_two_byte_sequence() {
        let mut carry = Vec::new();
        assert_eq!(decode_utf8_with_carry(&mut carry, &[b'a', 0xC3]), "a");
        assert_eq!(decode_utf8_with_carry(&mut carry, &[0xA9, b'b']), "éb");
        assert!(carry.is_empty());
    }

    #[test]
    fn decodes_split_three_byte_sequence() {
        let mut decoder = Utf8CarryDecoder::default();
        assert_eq!(decoder.decode(&[0xE2]), "");
        assert_eq!(decoder.decode(&[0x86]), "");
        assert_eq!(decoder.decode(&[0x92]), "\u{2192}");
    }

    #[test]
    fn decodes_split_four_byte_sequence() {
        let mut decoder = Utf8CarryDecoder::default();
        assert_eq!(decoder.decode(&[0xF0, 0x9F]), "");
        assert_eq!(decoder.decode(&[0x98]), "");
        assert_eq!(decoder.decode(&[0x80, b'!']), "\u{1F600}!");
    }

    #[test]
    fn replaces_real_invalid_bytes() {
        let mut carry = Vec::new();
        assert_eq!(
            decode_utf8_with_carry(&mut carry, &[b'a', 0xFF, b'b']),
            "a\u{FFFD}b",
        );
        assert!(carry.is_empty());
    }
}
