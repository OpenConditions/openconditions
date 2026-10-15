import java.io.FileInputStream;
import java.nio.file.Path;
import java.time.Instant;
import java.util.HashSet;
import org.traffxml.traff.TraffFeed;
import org.traffxml.traff.TraffLocation;
import org.traffxml.traff.TraffMessage;

/** Independent consumer assertions; uses upstream deserialization, never OC's XML parser. */
public class CheckTraff {
    public static void main(String[] args) throws Exception {
        String[] names = {"line", "point", "empty", "withheld", "bulk"};
        int[] counts = {1, 1, 0, 0, 5001};
        for (int i = 0; i < names.length; i++) {
            try (FileInputStream input = new FileInputStream(Path.of(args[0], names[i] + ".xml").toFile())) {
                TraffFeed feed = TraffFeed.read(input);
                if (feed.getMessages().size() != counts[i]) throw new AssertionError(names[i] + " count");
                HashSet<String> ids = new HashSet<>();
                for (TraffMessage message : feed.getMessages()) {
                    if (!ids.add(message.id)) throw new AssertionError("duplicate ID");
                    if (message.location.directionality != TraffLocation.Directionality.BOTH_DIRECTIONS)
                        throw new AssertionError("bidirectionality lost");
                    if (message.location.direction != null) throw new AssertionError("direction on bidirectional message");
                    if (!message.receiveTime.toInstant().equals(Instant.parse("2026-09-06T09:30:00Z")))
                        throw new AssertionError("receive time changed");
                    if (!message.updateTime.toInstant().equals(Instant.parse("2026-09-06T09:00:00Z")))
                        throw new AssertionError("update time changed");
                    if (message.events.length != 2) throw new AssertionError("events lost");
                }
                if (names[i].equals("line") && feed.getMessages().get(0).location.from == null)
                    throw new AssertionError("line endpoints lost");
                if (names[i].equals("point") && feed.getMessages().get(0).location.at == null)
                    throw new AssertionError("point lost");
                System.out.println(names[i] + ": " + counts[i] + " messages accepted");
            }
        }
    }
}
