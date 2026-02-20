use suppaftp::AsyncFtpStream;

fn main() {
    let _ = AsyncFtpStream::connect("localhost:21");
}
