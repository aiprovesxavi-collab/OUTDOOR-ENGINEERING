package barcelona.outdoor.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.content.ContentResolver;
import android.content.res.Resources;
import android.media.AudioAttributes;
import android.net.Uri;
import android.os.Build;

import androidx.annotation.NonNull;
import androidx.annotation.RequiresPermission;

/**
 * Sends every notification delegated by the browser to one channel, "Avisos", which plays
 * res/raw/notificacio.ogg.
 *
 * androidx.browser's TrustedWebActivityService turns a channel name into the id
 * name.toLowerCase(Locale.ROOT).replace(' ', '_') + "_channel_id" and creates that channel with
 * default settings only if it does not exist yet. Creating "avisos_channel_id" here first, with
 * the custom sound, makes the sound stick. Caller verification stays in the library.
 */
public class DelegationService extends
        com.google.androidbrowserhelper.trusted.DelegationService {

    private static final String CHANNEL_NAME = "Avisos";
    private static final String CHANNEL_ID = "avisos_channel_id";

    @Override
    public void onCreate() {
        super.onCreate();

        ensureAvisosChannel();
    }

    @Override
    @RequiresPermission(android.Manifest.permission.POST_NOTIFICATIONS)
    public boolean onNotifyNotificationWithChannel(@NonNull String platformTag, int platformId,
            @NonNull Notification notification, @NonNull String channelName) {
        ensureAvisosChannel();
        return super.onNotifyNotificationWithChannel(
                platformTag, platformId, notification, CHANNEL_NAME);
    }

    private void ensureAvisosChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;

        NotificationManager manager = getSystemService(NotificationManager.class);
        if (manager == null || manager.getNotificationChannel(CHANNEL_ID) != null) return;

        // android.resource://barcelona.outdoor.app/raw/notificacio
        Resources res = getResources();
        Uri sound = new Uri.Builder()
                .scheme(ContentResolver.SCHEME_ANDROID_RESOURCE)
                .authority(getPackageName())
                .appendPath(res.getResourceTypeName(R.raw.notificacio))
                .appendPath(res.getResourceEntryName(R.raw.notificacio))
                .build();
        AudioAttributes audioAttributes = new AudioAttributes.Builder()
                .setUsage(AudioAttributes.USAGE_NOTIFICATION)
                .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                .build();

        NotificationChannel channel = new NotificationChannel(
                CHANNEL_ID, CHANNEL_NAME, NotificationManager.IMPORTANCE_HIGH);   // sound and heads-up: work alerts must be seen at once
        channel.setSound(sound, audioAttributes);
        channel.enableVibration(true);
        channel.setShowBadge(true);
        manager.createNotificationChannel(channel);
    }
}
