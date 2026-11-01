// One JSON configuration for the whole protocol: camelCase names, no nulls on the wire, unknown fields ignored, dates left
// as the strings they are. Dictionary keys (slot names, asset ids, param ids) are NEVER renamed: they are data.
using Newtonsoft.Json;
using Newtonsoft.Json.Serialization;

namespace Mira.Stage
{
    public static class StageJson
    {
        public static readonly JsonSerializerSettings Settings = new JsonSerializerSettings
        {
            ContractResolver = new DefaultContractResolver
            {
                NamingStrategy = new CamelCaseNamingStrategy { ProcessDictionaryKeys = false, OverrideSpecifiedNames = true },
            },
            NullValueHandling = NullValueHandling.Ignore,
            MissingMemberHandling = MissingMemberHandling.Ignore,
            DateParseHandling = DateParseHandling.None,
            FloatParseHandling = FloatParseHandling.Double,
            Formatting = Formatting.None,
        };

        public static readonly JsonSerializer Serializer = JsonSerializer.Create(Settings);

        public static string Serialize(object value) => JsonConvert.SerializeObject(value, Settings);
    }
}
