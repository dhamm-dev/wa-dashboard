# Customer signup policy

Customer registration is disabled by default. `DHEXBOT_PRIVATE_PREVIEW=1` explicitly disables it, including when `DHEXBOT_PUBLIC_SIGNUP=1` is also set. Existing customer and admin logins and Google admin linking remain available.

For isolated staging and test environments only, `DHEXBOT_PUBLIC_SIGNUP=1` enables first-time email and Google customer provisioning when private preview is not set to `1`. Public signup must remain disabled until customer deletion functionality is complete and public registration is approved. Environment changes require restarting the server.

With signup disabled, email registration returns HTTP 403 with a generic error before password hashing. A first-time web Google login returns HTTP 403; Android Google callback returns a generic failure and its poll fails. These responses use `Cache-Control: no-store`. No customer is created. Existing accounts can still sign in. There is no special development-user provisioning mechanism in this policy; use an isolated staging environment to create a test user.
