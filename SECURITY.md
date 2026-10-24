# Security Policy

Please do not disclose credentials or security vulnerabilities in public
issues. Report vulnerabilities privately through GitHub Security Advisories.

Mai can execute model-requested commands. The default approval mode may run
tools without prompts, but configured tool permissions and `mai-sandbox`
remain the execution boundary. Review deployment settings before exposing the
HTTP API outside localhost and always configure `MAI_API_KEY` for non-loopback
listeners.
