package com.crossroads.player;

import android.content.Context;
import android.content.SharedPreferences;
import android.os.Build;
import android.security.KeyStoreException;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyPermanentlyInvalidatedException;
import android.security.keystore.KeyProperties;
import android.util.Base64;

import androidx.annotation.Nullable;
import androidx.annotation.RequiresApi;

import com.getcapacitor.Logger;

import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.util.Arrays;

import javax.crypto.AEADBadTagException;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/**
 * Small secrets (the sync pairing keys and their frame counters, #25) encrypted with an
 * AES-256-GCM key that lives in the Android Keystore and never leaves it; the ciphertext sits
 * in SharedPreferences ("crossroads_sync_secrets", excluded from backups: a copy is useless
 * without this device's Keystore key).
 *
 * Losing a pairing silently is the worst outcome, so the store errs towards "try again":
 * <ul>
 *   <li>An entry is dropped only when it is provably unrecoverable: the GCM tag does not verify
 *       (the blob is corrupt or was written under another key), the blob is not even well
 *       formed, the Keystore reports the key as permanently invalidated, or (API 33+) the
 *       Keystore operation itself says the key does not exist or is corrupted.</li>
 *   <li>Everything else, including a plain InvalidKeyException, an UnrecoverableKeyException,
 *       a KeyStoreException flagged transient and any error we cannot classify, is reported to
 *       the caller as {@link TransientException}: the entry stays and the caller retries later
 *       or tells the user.</li>
 *   <li>The wrapping key is generated once, in {@link #set} and only while there are no blobs
 *       at all. A missing alias while blobs exist is a Keystore hiccup or a wiped Keystore, and
 *       the two are indistinguishable from here: {@link #get} reports it as transient instead
 *       of dropping the entries, and {@link #set} refuses to create a new key that would make
 *       the existing blobs undecryptable. The way out of a genuinely wiped Keystore is the
 *       user unpairing the affected desktop (which deletes its blob); once no blob is left a new
 *       key is created on the next pairing.</li>
 * </ul>
 */
final class SecretStore {

    private static final String TAG = "SecretStore";
    static final String PREFS = "crossroads_sync_secrets";
    private static final String ALIAS = "crossroads.sync.secrets";
    private static final String KEYSTORE = "AndroidKeyStore";
    private static final int IV_BYTES = 12;
    private static final int TAG_BITS = 128;

    /** The secret exists but could not be read (or written) right now; retrying later may work. */
    static final class TransientException extends Exception {
        TransientException(String message, @Nullable Throwable cause) {
            super(message, cause);
        }
    }

    private final SharedPreferences prefs;

    SecretStore(Context context) {
        prefs = context.getApplicationContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    /**
     * @return the stored value, or null when there is none (or it was unrecoverable and has
     *         been dropped).
     * @throws TransientException when the value exists but cannot be read at the moment.
     */
    @Nullable
    synchronized String get(String name) throws TransientException {
        String stored = prefs.getString(name, null);
        if (stored == null) return null;
        byte[] blob;
        try {
            blob = Base64.decode(stored, Base64.NO_WRAP);
            if (blob.length <= IV_BYTES) throw new IllegalArgumentException("short blob");
        } catch (IllegalArgumentException e) {
            Logger.error(TAG, "secret corrupt, dropping " + name, e);
            prefs.edit().remove(name).apply();
            return null;
        }
        SecretKey key = existingKey();   // transient when the alias is not there: blobs exist
        try {
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.DECRYPT_MODE, key, new GCMParameterSpec(TAG_BITS, Arrays.copyOfRange(blob, 0, IV_BYTES)));
            return new String(cipher.doFinal(Arrays.copyOfRange(blob, IV_BYTES, blob.length)), StandardCharsets.UTF_8);
        } catch (Exception e) {
            if (isPermanent(e)) {
                Logger.error(TAG, "secret unrecoverable, dropping " + name + " (" + e.getClass().getSimpleName() + ")", e);
                prefs.edit().remove(name).apply();
                return null;
            }
            Logger.error(TAG, "secret temporarily unreadable: " + name, e);
            throw new TransientException("Could not read the stored key right now (" + e.getClass().getSimpleName() + ")", e);
        }
    }

    /**
     * True only when no retry can ever succeed. Walks the cause chain: the Keystore wraps its
     * own exception in the JCA one (InvalidKeyException -> KeyStoreException).
     */
    static boolean isPermanent(Throwable e) {
        for (Throwable t = e; t != null; t = t.getCause()) {
            if (t instanceof AEADBadTagException) return true;               // wrong key or corrupt ciphertext
            if (t instanceof KeyPermanentlyInvalidatedException) return true;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU && t instanceof KeyStoreException) {
                return isPermanentKeyStoreError((KeyStoreException) t);
            }
        }
        // InvalidKeyException, UnrecoverableKeyException, ProviderException, timeouts, unknown: retry.
        return false;
    }

    /** API 33+: the Keystore says whether a failure is transient, and which key problem it was. */
    @RequiresApi(Build.VERSION_CODES.TIRAMISU)
    private static boolean isPermanentKeyStoreError(KeyStoreException e) {
        if (e.isTransientFailure()) return false;
        int code = e.getNumericErrorCode();
        return code == KeyStoreException.ERROR_KEY_DOES_NOT_EXIST || code == KeyStoreException.ERROR_KEY_CORRUPTED;
    }

    /** @throws TransientException when the Keystore cannot be used right now (the value is not stored). */
    synchronized void set(String name, String value) throws Exception {
        SecretKey key = prefs.getAll().isEmpty() ? keyForFirstBlob() : existingKey();
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.ENCRYPT_MODE, key);
        byte[] iv = cipher.getIV();
        byte[] ct = cipher.doFinal(value.getBytes(StandardCharsets.UTF_8));
        byte[] blob = new byte[iv.length + ct.length];
        System.arraycopy(iv, 0, blob, 0, iv.length);
        System.arraycopy(ct, 0, blob, iv.length, ct.length);
        if (!prefs.edit().putString(name, Base64.encodeToString(blob, Base64.NO_WRAP)).commit()) {
            throw new IllegalStateException("preferences write failed");
        }
    }

    synchronized void delete(String name) {
        prefs.edit().remove(name).commit();
    }

    /** The wrapping key, which must already exist because blobs do; never creates one. */
    private SecretKey existingKey() throws TransientException {
        SecretKey key;
        try {
            key = loadKey();
        } catch (Exception e) {
            Logger.error(TAG, "keystore unavailable", e);
            throw new TransientException("The secure key store is not available right now (" + e.getClass().getSimpleName() + ")", e);
        }
        if (key == null) {
            Logger.error(TAG, "wrapping key alias missing while secrets exist; keeping them", null);
            throw new TransientException("The key protecting the stored pairing keys is not available right now", null);
        }
        return key;
    }

    /** The wrapping key for a store with no blobs: the existing one, or a fresh one. */
    private SecretKey keyForFirstBlob() throws Exception {
        SecretKey key = loadKey();
        if (key != null) return key;
        KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, KEYSTORE);
        generator.init(new KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setKeySize(256)
            .build());
        return generator.generateKey();
    }

    /** The wrapping key, or null when the alias is absent. */
    @Nullable
    private static SecretKey loadKey() throws Exception {
        KeyStore keyStore = KeyStore.getInstance(KEYSTORE);
        keyStore.load(null);
        if (!keyStore.containsAlias(ALIAS)) return null;
        KeyStore.Entry entry = keyStore.getEntry(ALIAS, null);
        return entry instanceof KeyStore.SecretKeyEntry ? ((KeyStore.SecretKeyEntry) entry).getSecretKey() : null;
    }
}
