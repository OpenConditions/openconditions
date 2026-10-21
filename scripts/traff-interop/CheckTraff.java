import java.io.FileInputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Instant;
import java.util.HashSet;
import java.util.List;
import javax.xml.XMLConstants;
import javax.xml.parsers.DocumentBuilderFactory;
import org.w3c.dom.Element;
import org.w3c.dom.NodeList;
import org.traffxml.traff.TraffEvent;
import org.traffxml.traff.TraffFeed;
import org.traffxml.traff.TraffLocation;
import org.traffxml.traff.TraffMessage;
import org.traffxml.traff.TraffSupplementaryInfo;

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
        try (FileInputStream input = new FileInputStream(Path.of(args[0], "timing.xml").toFile())) {
            TraffFeed feed = TraffFeed.read(input);
            if (feed.getMessages().size() != 1) throw new AssertionError("broad nature closure recreated");
            TraffMessage message = feed.getMessages().get(0);
            if (!message.id.endsWith("#closure") || message.events.length != 1
                    || !message.startTime.toInstant().equals(Instant.parse("2026-09-07T10:00:00Z"))
                    || !message.endTime.toInstant().equals(Instant.parse("2026-09-07T11:00:00Z")))
                throw new AssertionError("effect interval widened");
        }
        System.out.println("timing: future effect interval preserved without broad nature closure");
        Path delays = Path.of(args[0], "delays.xml");
        DocumentBuilderFactory factory = DocumentBuilderFactory.newInstance();
        factory.setFeature(XMLConstants.FEATURE_SECURE_PROCESSING, true);
        factory.setFeature("http://apache.org/xml/features/disallow-doctype-decl", true);
        NodeList events = factory.newDocumentBuilder().parse(delays.toFile()).getElementsByTagName("event");
        if (events.getLength() != 3) throw new AssertionError("distinct delays lost");
        Element shortDelay = (Element) events.item(1);
        Element longDelay = (Element) events.item(2);
        if (!shortDelay.getAttribute("q_duration").equals("0:10")
                || !shortDelay.getAttribute("length").equals("2400")
                || !longDelay.getAttribute("q_duration").equals("1:30")
                || longDelay.hasAttribute("length"))
            throw new AssertionError("delay duration/queue wire values changed");
        try (FileInputStream input = new FileInputStream(delays.toFile())) {
            TraffFeed feed = TraffFeed.read(input);
            if (feed.getMessages().size() != 1) throw new AssertionError("delay message lost");
            TraffMessage message = feed.getMessages().get(0);
            if (message.events.length != 3 || message.events[1].length != 2400)
                throw new AssertionError("reader lost delay events or queue length");
            // The pinned reader's constructor has TODO qDuration. It accepts the
            // attribute but drops it: DOM assertions above verify the wire value.
            if (message.events[1].getDurationQuantifier() != null
                    || message.events[2].getDurationQuantifier() != null)
                throw new AssertionError("reader duration support changed; update the compatibility contract");
        }
        System.out.println("delays: wire values verified; pinned reader accepts but discards q_duration");
        checkNatures(Path.of(args[0]));
        checkEffects(Path.of(args[0]));
    }

    /** Every crosswalk nature reads back as its own type, in the class the reader assigns it. */
    static void checkNatures(Path dir) throws Exception {
        List<String> expected = Files.readAllLines(dir.resolve("natures.txt"));
        try (FileInputStream input = new FileInputStream(dir.resolve("natures.xml").toFile())) {
            List<TraffMessage> messages = TraffFeed.read(input).getMessages();
            if (messages.size() != expected.size()) throw new AssertionError("nature messages lost");
            for (int i = 0; i < messages.size(); i++) {
                TraffEvent event = messages.get(i).events[0];
                if (event.type == null || !event.type.name().equals(expected.get(i)))
                    throw new AssertionError("nature " + expected.get(i) + " read as " + event.type);
                if (event.eventClass == null || !event.type.name().startsWith(event.eventClass.name() + "_"))
                    throw new AssertionError(expected.get(i) + " has class " + event.eventClass);
            }
        }
        System.out.println("natures: " + expected.size() + " crosswalk event types accepted with their classes");
    }

    /** Each effect's event, its quantifier and the diversion note, plus the message attributes. */
    static void checkEffects(Path dir) throws Exception {
        String[] expected = {
            "RESTRICTION_CLOSED", "RESTRICTION_CARRIAGEWAY_CLOSED", "RESTRICTION_RAMP_CLOSED",
            "RESTRICTION_CLOSED", "RESTRICTION_CLOSED", "RESTRICTION_CLOSED",
            "RESTRICTION_LANE_CLOSED", "RESTRICTION_RESTRICTIONS", "RESTRICTION_CONTRAFLOW",
            "RESTRICTION_SPEED_LIMIT", "DELAY_UNCERTAIN_DURATION", "DELAY_LONG_DELAY",
            "DELAY_VERY_LONG_DELAY", "RESTRICTION_CLOSED",
        };
        try (FileInputStream input = new FileInputStream(dir.resolve("effects.xml").toFile())) {
            List<TraffMessage> messages = TraffFeed.read(input).getMessages();
            if (messages.size() != expected.length) throw new AssertionError("effect messages lost");
            for (int i = 0; i < expected.length; i++) {
                TraffMessage message = messages.get(i);
                if (message.events.length != 2
                        || message.events[0].type != TraffEvent.Type.INCIDENT_ACCIDENT
                        || message.events[0].eventClass != TraffEvent.Class.INCIDENT
                        || !message.events[1].type.name().equals(expected[i])
                        || !expected[i].startsWith(message.events[1].eventClass.name() + "_"))
                    throw new AssertionError(message.id + " events changed");
                if (!message.isForecast) throw new AssertionError(message.id + " forecast lost");
                if (message.urgency != TraffMessage.Urgency.X_URGENT)
                    throw new AssertionError(message.id + " urgency changed");
                TraffLocation location = message.location;
                if (!"Düsseldorf <Süd> & \"Nord\" � ✓".equals(location.roadName)
                        || !"A 46".equals(location.roadRef)
                        || location.roadClass != TraffLocation.RoadClass.MOTORWAY
                        || !"AK Düsseldorf-Süd".equals(location.from.junctionName)
                        || !"AS Erkrath".equals(location.to.junctionName))
                    throw new AssertionError(message.id + " road attributes changed");
            }
            if (messages.get(9).events[1].speed != 60) throw new AssertionError("speed limit changed");
            TraffSupplementaryInfo[] notes = messages.get(13).events[0].supplementaryInfos;
            if (notes.length != 1 || notes[0].siClass != TraffSupplementaryInfo.Class.DIVERSION
                    || notes[0].type != TraffSupplementaryInfo.Type.S_DIVERSION_FOLLOW_DIVERSION_SIGNS)
                throw new AssertionError("diversion lost");
        }
        System.out.println("effects: " + expected.length + " effect events, quantifiers and road attributes accepted");
    }
}
