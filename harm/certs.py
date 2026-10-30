"""HaRM's local HTTPS: a private certificate authority plus a server certificate.

Phones trust the authority once; the server certificate can then be re-issued (for a new IP,
a new hostname) without touching the phones again. Pure Python, so it works on Windows too.

    python -m harm.certs harm-server 192.168.1.50   # names and/or IPs HaRM is reached by
"""

import datetime as dt
import ipaddress
import os
import socket
import sys
from pathlib import Path

from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.x509.oid import ExtendedKeyUsageOID, NameOID

from . import db

TLS = db.DB_PATH.parent / "tls"
CA_CRT, CA_KEY = TLS / "harm-ca.crt", TLS / "harm-ca.key"
CRT, KEY = TLS / "harm.crt", TLS / "harm.key"
CA_NAME = "Zom's HaRM local CA"


def _write(path: Path, data: bytes, private: bool) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_bytes(data)
    try:
        os.chmod(tmp, 0o600 if private else 0o644)
    except OSError:
        pass
    os.replace(tmp, path)


def _pem_key(key) -> bytes:
    return key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.TraditionalOpenSSL,
                             serialization.NoEncryption())


def _now() -> dt.datetime:
    return dt.datetime.now(dt.timezone.utc)


def ensure_ca():
    """Load the local CA, creating it the first time (valid 10 years)."""
    if CA_CRT.exists() and CA_KEY.exists():
        key = serialization.load_pem_private_key(CA_KEY.read_bytes(), password=None)
        return x509.load_pem_x509_certificate(CA_CRT.read_bytes()), key
    key = rsa.generate_private_key(public_exponent=65537, key_size=3072)
    name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, CA_NAME)])
    cert = (x509.CertificateBuilder().subject_name(name).issuer_name(name).public_key(key.public_key())
            .serial_number(x509.random_serial_number())
            .not_valid_before(_now() - dt.timedelta(days=1)).not_valid_after(_now() + dt.timedelta(days=3650))
            .add_extension(x509.BasicConstraints(ca=True, path_length=0), critical=True)
            .add_extension(x509.KeyUsage(digital_signature=False, content_commitment=False, key_encipherment=False,
                                         data_encipherment=False, key_agreement=False, key_cert_sign=True,
                                         crl_sign=True, encipher_only=False, decipher_only=False), critical=True)
            .add_extension(x509.SubjectKeyIdentifier.from_public_key(key.public_key()), critical=False)
            .sign(key, hashes.SHA256()))
    _write(CA_KEY, _pem_key(key), private=True)
    _write(CA_CRT, cert.public_bytes(serialization.Encoding.PEM), private=False)
    return cert, key


def make_server_cert(names: list[str]) -> list[str]:
    """Issue harm.crt for localhost plus `names` (hostnames or IPs). Returns the names covered."""
    ca, ca_key = ensure_ca()
    wanted = list(dict.fromkeys(["localhost", "127.0.0.1", *[n.strip() for n in names if n and n.strip()]]))
    sans = []
    for n in wanted:
        try:
            sans.append(x509.IPAddress(ipaddress.ip_address(n)))
        except ValueError:
            sans.append(x509.DNSName(n))
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    # iPhone/iPad reject server certificates whose total lifetime (not-before to not-after) is over
    # 825 days, even from a trusted authority. Stay well under it, counting the small backdate.
    start = _now() - dt.timedelta(hours=1)
    cert = (x509.CertificateBuilder()
            .subject_name(x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, wanted[-1])]))
            .issuer_name(ca.subject).public_key(key.public_key()).serial_number(x509.random_serial_number())
            .not_valid_before(start).not_valid_after(start + dt.timedelta(days=820))
            .add_extension(x509.SubjectAlternativeName(sans), critical=False)
            .add_extension(x509.BasicConstraints(ca=False, path_length=None), critical=True)
            .add_extension(x509.ExtendedKeyUsage([ExtendedKeyUsageOID.SERVER_AUTH]), critical=False)
            .add_extension(x509.KeyUsage(digital_signature=True, content_commitment=False, key_encipherment=True,
                                         data_encipherment=False, key_agreement=False, key_cert_sign=False,
                                         crl_sign=False, encipher_only=False, decipher_only=False), critical=True)
            .add_extension(x509.AuthorityKeyIdentifier.from_issuer_public_key(ca_key.public_key()), critical=False)
            .sign(ca_key, hashes.SHA256()))
    _write(KEY, _pem_key(key), private=True)
    _write(CRT, cert.public_bytes(serialization.Encoding.PEM), private=False)
    return wanted


def cert_names() -> set[str]:
    """Hostnames and IPs the current server certificate covers."""
    try:
        cert = x509.load_pem_x509_certificate(CRT.read_bytes())
        san = cert.extensions.get_extension_for_class(x509.SubjectAlternativeName).value
    except (OSError, ValueError, x509.ExtensionNotFound):
        return set()
    return {str(v) for v in san.get_values_for_type(x509.IPAddress)} | set(san.get_values_for_type(x509.DNSName))


def local_names() -> list[str]:
    """This computer's hostname and LAN IPv4 addresses (best effort, any OS)."""
    names = [socket.gethostname()]
    try:
        for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            names.append(info[4][0])
    except OSError:
        pass
    try:  # No packet is sent; this asks the OS which address it would use for the LAN.
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.connect(("10.255.255.255", 1))
            names.append(s.getsockname()[0])
    except OSError:
        pass
    return [n for n in dict.fromkeys(names) if not n.startswith("127.")]


def ensure(names: list[str]) -> bool:
    """Make sure a valid certificate exists that covers `names` (and passes phone rules).
    Re-issues only when needed, keeping the same authority. Returns True if it issued one."""
    try:
        cert = x509.load_pem_x509_certificate(CRT.read_bytes())
        ok = (KEY.exists() and set(n.strip() for n in names if n.strip()) <= cert_names()
              and (cert.not_valid_after_utc - cert.not_valid_before_utc).days <= 825
              and cert.not_valid_after_utc > _now() + dt.timedelta(days=30))
    except (OSError, ValueError):
        ok = False
    if ok:
        return False
    keep = sorted(cert_names() - {"localhost", "127.0.0.1"}) if CRT.exists() else []
    make_server_cert(list(dict.fromkeys([*names, *keep])))
    return True


if __name__ == "__main__":
    args = sys.argv[1:]
    if args[:1] == ["--ensure"]:
        names = args[1:] or local_names()
        print("Certificate issued for:" if ensure(names) else "Certificate already covers:", ", ".join(sorted(cert_names())))
        sys.exit(0)
    if any(a.startswith("-") for a in args):
        print(__doc__.strip())
        sys.exit(0 if args[0] in ("-h", "--help") else 2)
    covered = make_server_cert(args or local_names())
    print("Certificate for:", ", ".join(covered))
    print(f"Trust it on phones by installing: {CA_CRT}")
