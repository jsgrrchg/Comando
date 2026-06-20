pub fn diagnostic(message: impl AsRef<str>) {
    eprintln!("[comando-native-backend] {}", message.as_ref());
}
