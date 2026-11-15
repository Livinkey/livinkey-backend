const {
    sendAuthError, verifyRequestToken, assertAccountActive, enforcePasswordChangeScope, AuthError
} = require("../utils/auth.core");

const authMiddleware = async (req, res, next) => {
    try {
        const decoded = verifyRequestToken(req);
        if (decoded.role !== "super_admin" && decoded.role !== "admin") {
            throw new AuthError(403, "FORBIDDEN", "You don't have access to this area.");
        }
        await enforcePasswordChangeScope(decoded, req);
        const account = await assertAccountActive(decoded);
        // Trust the role stored in the database, not the one baked into an old token.
        decoded.role = account.role || decoded.role;
        // The JWT carries no name; use the real person's name from the database so every
        // message, email and audit entry is signed by the actual admin (never by their role).
        if (account.name) decoded.name = account.name;
        req.admin = decoded;
        next();
    } catch (error) {
        return sendAuthError(res, error);
    }
};

module.exports = authMiddleware;
